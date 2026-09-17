import { parentPort, workerData } from "node:worker_threads";
import ical, { type ParameterValue, type VEvent } from "node-ical";
const value = (v?: ParameterValue) =>
  typeof v === "string" ? v : (v?.val ?? "");
export function expand(
  ics: string,
  from: string,
  to: string,
  timezone: string,
) {
  if (!ics.includes("BEGIN:VCALENDAR") || !ics.includes("END:VCALENDAR"))
    throw new Error("INVALID_ICS");
  // Floating local times are interpreted explicitly in the configured display zone.
  const normalized = ics
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .replace(
      /^(DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE):([0-9]{8}T[0-9]{6}(?:,[0-9]{8}T[0-9]{6})*)$/gm,
      `$1;TZID=${timezone}:$2`,
    );
  for (const match of normalized.matchAll(/;TZID=(?:"([^"]+)"|([^;:\n]+))/g)) {
    try {
      new Intl.DateTimeFormat("de", { timeZone: match[1] ?? match[2] });
    } catch {
      throw new Error("UNSUPPORTED_TIMEZONE");
    }
  }
  const parsed = ical.sync.parseICS(normalized);
  const items = [];
  for (const ev of Object.values(parsed)) {
    if (!ev || ev.type !== "VEVENT") continue;
    if (!ev.uid || !ev.start) throw new Error("INVALID_EVENT");
    // Unsupported range overrides must never silently produce incorrect schedules.
    if (/RECURRENCE-ID[^\r\n]*RANGE=THISANDFUTURE/i.test(normalized))
      throw new Error("UNSUPPORTED_RANGE_OVERRIDE");
    addRdates(ev);
    const instances = ical.expandRecurringEvent(ev, {
      from: new Date(from),
      to: new Date(to),
      expandOngoing: true,
    });
    for (const x of instances) {
      if (
        +x.start >= +new Date(to) ||
        (+x.end <= +new Date(from) && +x.start !== +new Date(from))
      )
        continue;
      const cancelled =
        parsed.vcalendar?.method === "CANCEL" ||
        ev.status === "CANCELLED" ||
        x.event.status === "CANCELLED";
      const fmt = (date: Date) =>
        new Intl.DateTimeFormat("sv-SE", {
          timeZone: timezone,
          dateStyle: "short",
          timeStyle: "long",
        }).format(date);
      const allDay = x.isFullDay;
      const dateOnly = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      items.push({
        uid: ev.uid,
        recurrenceId:
          x.event.recurrenceid?.toISOString() ?? x.start.toISOString(),
        title: value(x.summary).slice(0, 1000),
        start: allDay ? dateOnly(x.start) : x.start.toISOString(),
        end: allDay ? dateOnly(x.end) : x.end.toISOString(),
        timezone: x.event.start?.tz ?? ev.start.tz ?? timezone,
        displayTimezone: timezone,
        displayStart: allDay ? dateOnly(x.start) : fmt(x.start),
        displayEnd: allDay ? dateOnly(x.end) : fmt(x.end),
        allDay,
        cancelled,
        location: value(x.event.location ?? ev.location).slice(0, 2000),
        description: value(x.event.description ?? ev.description).slice(
          0,
          12000,
        ),
        descriptionTruncated:
          value(x.event.description ?? ev.description).length > 12000,
      });
      if (items.length > 10000) throw new Error("EXPANSION_LIMIT");
    }
  }
  return items;
}
// node-ical expands RRULE/EXDATE/overrides; merge explicit RDATEs into its date set.
function addRdates(event: VEvent) {
  if (!event.rdate) return;
  const values = Array.isArray(event.rdate) ? event.rdate : [event.rdate];
  const dates: Date[] = [];
  for (const entry of values) {
    const item =
      typeof entry === "string"
        ? { val: entry, params: {} }
        : (entry as { val: string; params: Record<string, string> });
    if (
      !item ||
      typeof item.val !== "string" ||
      item.params?.VALUE === "PERIOD"
    )
      throw new Error("UNSUPPORTED_RDATE");
    const params = Object.entries(item.params ?? {})
      .map(([key, val]) => `;${key}=${val}`)
      .join("");
    for (const raw of item.val.split(",")) {
      const parsed = ical.sync.parseICS(
        `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:rdate-helper\nDTSTART${params}:${raw}\nEND:VEVENT\nEND:VCALENDAR`,
      );
      const component = parsed["rdate-helper"];
      if (
        !component ||
        component.type !== "VEVENT" ||
        !Number.isFinite(+component.start)
      )
        throw new Error("INVALID_RDATE");
      const d = component.start;
      dates.push(
        event.datetype === "date"
          ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
          : d,
      );
    }
  }
  const original = event.rrule;
  const initial =
    event.datetype === "date"
      ? new Date(
          Date.UTC(
            event.start.getFullYear(),
            event.start.getMonth(),
            event.start.getDate(),
          ),
        )
      : event.start;
  event.rrule = {
    ...original,
    between: (from: Date, to: Date) => {
      const result = [
        ...(original?.between(from, to, true) ?? []),
        initial,
        ...dates,
      ].filter((d) => +d >= +from && +d <= +to);
      return [...new Map(result.map((d) => [+d, d])).values()].sort(
        (a, b) => +a - +b,
      );
    },
  } as NonNullable<VEvent["rrule"]>;
}
if (parentPort) {
  try {
    parentPort.postMessage({
      items: expand(
        workerData.ics,
        workerData.from,
        workerData.to,
        workerData.timezone,
      ),
    });
  } catch {
    parentPort.postMessage({ error: "CALENDAR_PARSE_ERROR" });
  }
}
