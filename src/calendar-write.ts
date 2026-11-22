import { fail } from "./common.js";

export type CalendarFields = {
  title: string;
  start: string;
  end: string;
  description?: string | null;
  location?: string | null;
};

export type CalendarRef = {
  calendar: string;
  href: string;
  uid: string;
  etag: string;
};

export const strongEtag = (value: unknown): value is string =>
  typeof value === "string" && /^"[^"\x00-\x20\x7f]*"$/.test(value);

function property(line: string) {
  return line.split(/[;:]/, 1)[0].toUpperCase();
}

export function singleEvent(ics: string) {
  const lines = ics
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter(Boolean);
  const stack: string[] = [];
  const fields = new Map<string, number[]>();
  let end = -1;
  let events = 0;
  for (const [index, line] of lines.entries()) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const component = upper.slice(6);
      if (!stack.length && (index !== 0 || component !== "VCALENDAR")) return;
      if (stack.length === 1 && !["VEVENT", "VTIMEZONE"].includes(component))
        return;
      if (component === "VEVENT" && (stack.length !== 1 || ++events !== 1))
        return;
      stack.push(component);
    } else if (upper.startsWith("END:")) {
      const component = upper.slice(4);
      if (stack.pop() !== component) return;
      if (component === "VEVENT") end = index;
      if (!stack.length && index !== lines.length - 1) return;
    } else if (stack.length === 2 && stack[1] === "VEVENT") {
      const key = property(line);
      if (["RRULE", "RDATE", "EXRULE", "EXDATE", "RECURRENCE-ID"].includes(key))
        return;
      fields.set(key, [...(fields.get(key) ?? []), index]);
    }
  }
  const uid = fields.get("UID");
  if (stack.length || end < 0 || uid?.length !== 1) return;
  return { lines, end, fields, uid: lines[uid[0]].split(/:(.*)/s)[1] };
}

function fold(line: string) {
  let output = "";
  let bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 75) {
      output += "\r\n ";
      bytes = 1;
    }
    output += character;
    bytes += size;
  }
  return output;
}

const timestamp = (value: string) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

const escapeText = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, "\\n")
    .replace(/[,;]/g, "\\$&");

export function editEvent(
  event: NonNullable<ReturnType<typeof singleEvent>>,
  patch: Partial<CalendarFields>,
) {
  const changes = new Map<string, string | null>();
  for (const [name, value] of [
    ["SUMMARY", patch.title],
    ["DESCRIPTION", patch.description],
    ["LOCATION", patch.location],
  ] as const) {
    if (value !== undefined)
      changes.set(name, value === null ? null : name + ":" + escapeText(value));
  }
  if (patch.start !== undefined || patch.end !== undefined) {
    const { start, end } = patch;
    if (
      !start ||
      !end ||
      (start.length === 10) !== (end.length === 10) ||
      Math.floor(Date.parse(end) / 1000) <= Math.floor(Date.parse(start) / 1000)
    )
      return fail(
        "INVALID_EVENT_TIME",
        "Start und Ende müssen zusammenpassen; Ende muss nach Start liegen.",
      );
    const allDay = start.length === 10;
    const format = (key: string, value: string) =>
      allDay
        ? key + ";VALUE=DATE:" + value.replace(/-/g, "")
        : key + ":" + timestamp(value);
    changes.set("DTSTART", format("DTSTART", start));
    changes.set("DTEND", format("DTEND", end));
    changes.set("DURATION", null);
  }
  if (!changes.size)
    return fail("EMPTY_UPDATE", "Mindestens ein Terminfeld ändern.");
  changes.set("DTSTAMP", "DTSTAMP:" + timestamp(new Date().toISOString()));
  const replaced = new Set(
    [...changes.keys()].flatMap((key) => event.fields.get(key) ?? []),
  );
  const added = [...changes.values()].filter(
    (line): line is string => line !== null,
  );
  const lines = event.lines.flatMap((line, index) =>
    index === event.end ? [...added, line] : replaced.has(index) ? [] : [line],
  );
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function newEvent(uid: string, fields: CalendarFields) {
  const event = singleEvent(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//PIM Management//CalDAV//EN\r\nBEGIN:VEVENT\r\nUID:" +
      uid +
      "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  if (!event) throw new Error("Invalid event template");
  return editEvent(event, fields);
}
