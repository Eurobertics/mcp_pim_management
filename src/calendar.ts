import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Config } from "./config.js";
import { decode, encode, fail, range, safeError } from "./common.js";
import type { expand } from "./calendar-worker.js";
type Event = ReturnType<typeof expand>[number] & {
  ref: { calendar: string; href: string; uid: string; recurrenceId: string };
};
const array = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
export async function boundedText(response: Response, max = 8 * 1024 * 1024) {
  if (!response.body) return fail("EMPTY_RESPONSE", "Leere CalDAV-Antwort.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        fail(
          "RESPONSE_TOO_LARGE",
          "CalDAV-Antwort überschreitet 8 MiB; Zeitraum verkleinern.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function expandSafe(
  ics: string,
  from: string,
  to: string,
  timezone: string,
): Promise<ReturnType<typeof expand>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./calendar-worker.js", import.meta.url), {
      workerData: { ics, from, to, timezone },
      resourceLimits: { maxOldGenerationSizeMb: 96 },
      stdout: true,
      stderr: true,
    });
    w.stdout.resume();
    w.stderr.resume();
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error("CALENDAR_TIMEOUT"));
    }, 5000);
    w.once("message", (data) => {
      clearTimeout(timer);
      void w.terminate();
      data.error ? reject(new Error(data.error)) : resolve(data.items);
    });
    w.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    w.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("CALENDAR_WORKER_EXIT"));
    });
  });
}
export class CalendarService {
  constructor(
    private config: Config,
    private fetcher: typeof fetch = fetch,
  ) {}
  async events(
    calendar: string,
    from: string,
    to: string,
    limit: number,
    cursor?: string,
  ) {
    range(from, to);
    const c =
      this.config.calendars.find((x) => x.id === calendar) ??
      fail("UNKNOWN_CALENDAR", "Unbekannter Kalender.");
    const stamp = (s: string) =>
      new Date(s).toISOString().replace(/[-:]/g, "").replace(".000", "");
    const body = `<?xml version="1.0" encoding="UTF-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const response = await this.fetcher(c.url, {
      method: "REPORT",
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`,
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 207)
      return fail(
        "CALDAV_HTTP",
        `CalDAV-Abruf fehlgeschlagen (HTTP ${response.status}).`,
      );
    const xml = await boundedText(response);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      return fail("INVALID_DAV", "Ungültige CalDAV-Antwort.");
    const doc = new XMLParser({
      removeNSPrefix: true,
      parseTagValue: false,
      trimValues: false,
    }).parse(xml);
    if (!Object.hasOwn(doc, "multistatus") || doc.multistatus?.error)
      return fail(
        "INVALID_DAV",
        "CalDAV-Multistatus fehlt oder meldet einen Fehler.",
      );
    const rows = array<any>(doc.multistatus.response);
    const items: Event[] = [];
    const errors: unknown[] = [];
    const deadline = Date.now() + 30000;
    for (const row of rows.slice(0, 500)) {
      if (Date.now() > deadline || items.length > 10000) {
        errors.push({
          code: "PROCESSING_LIMIT",
          message: "Kalenderauswertung begrenzt; Zeitraum verkleinern.",
        });
        break;
      }
      try {
        if (row.status && !/\s200\s/.test(row.status))
          fail("DAV_RESOURCE_ERROR", "Kalenderressource nicht abrufbar.");
        const props = array<any>(row.propstat);
        const good = props.filter((p) => /\s200\s/.test(p.status));
        const ics = good
          .map((p) => p.prop?.["calendar-data"])
          .find((x) => typeof x === "string");
        if (typeof row.href !== "string" || !ics)
          return fail(
            "DAV_RESOURCE_ERROR",
            "Kalenderdaten oder Referenz fehlen.",
          );
        for (const event of await expandSafe(
          ics,
          from,
          to,
          this.config.displayTimezone,
        ))
          items.push({
            ...event,
            ref: {
              calendar,
              href: row.href,
              uid: event.uid,
              recurrenceId: event.recurrenceId,
            },
          });
      } catch (e) {
        errors.push({ resourceIndex: rows.indexOf(row), ...safeError(e) });
      }
    }
    if (rows.length > 500)
      errors.push({
        code: "RESOURCE_LIMIT",
        message: "Mehr als 500 Kalenderressourcen; Zeitraum verkleinern.",
      });
    items.sort(
      (a, b) =>
        a.start.localeCompare(b.start) ||
        JSON.stringify(a.ref).localeCompare(JSON.stringify(b.ref)),
    );
    const hash = createHash("sha256")
      .update(JSON.stringify({ calendar, from, to, items, errors }))
      .digest("hex");
    const page = cursor
      ? decode<{ hash: string; offset: number }>(cursor)
      : { hash, offset: 0 };
    if (
      page.hash !== hash ||
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0
    )
      fail("STALE_CURSOR", "Kalender hat sich geändert; Abfrage neu beginnen.");
    return {
      items: items.slice(page.offset, page.offset + limit),
      errors,
      complete: errors.length === 0,
      untrustedContent: true,
      nextCursor:
        page.offset + limit < items.length
          ? encode({ hash, offset: page.offset + limit })
          : null,
    };
  }
}
