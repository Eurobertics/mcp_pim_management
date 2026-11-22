import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Config } from "./config.js";
import { decode, encode, fail, range, safeError } from "./common.js";
import type { expand } from "./calendar-worker.js";
import {
  editEvent,
  newEvent,
  singleEvent,
  strongEtag,
  type CalendarFields,
  type CalendarRef,
} from "./calendar-write.js";
type Event = ReturnType<typeof expand>[number] & {
  ref: {
    calendar: string;
    href: string;
    uid: string;
    recurrenceId: string;
    etag?: string;
  };
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
  private source(calendar: string) {
    return (
      this.config.calendars.find((x) => x.id === calendar) ??
      fail("UNKNOWN_CALENDAR", "Unbekannter Kalender.")
    );
  }
  private collection(url: string) {
    const base = new URL(url);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return base;
  }
  private resource(base: URL, href: string) {
    const url = URL.parse(href, base);
    const name = url?.pathname.slice(base.pathname.length);
    if (
      !url ||
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(base.pathname) ||
      !name ||
      /[\\/]|%2f|%5c|%00|%25/i.test(name)
    )
      return fail(
        "INVALID_CALENDAR_REFERENCE",
        "Ressource gehört nicht zum Kalender.",
      );
    return url;
  }
  private request(
    c: ReturnType<CalendarService["source"]>,
    url: string,
    options: RequestInit,
  ) {
    return this.fetcher(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization:
          "Basic " +
          Buffer.from(c.username + ":" + c.password).toString("base64"),
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  }
  private checkResponse(response: Response) {
    if (response.status === 412)
      fail(
        "CALENDAR_CONFLICT",
        "Kalenderressource hat sich geändert; Termin neu laden.",
      );
    if (response.status === 404)
      fail("NOT_FOUND", "Kalenderressource wurde nicht gefunden.");
    if (!response.ok)
      fail(
        "CALDAV_HTTP",
        "CalDAV-Aktion fehlgeschlagen (HTTP " + response.status + ").",
      );
  }
  private async write(
    c: ReturnType<CalendarService["source"]>,
    url: URL,
    options: RequestInit,
  ) {
    let response: Response;
    try {
      response = await this.request(c, url.href, options);
    } catch {
      return fail(
        "CALENDAR_WRITE_UNCERTAIN",
        "Ausgang der Kalenderaktion unklar; Kalender vor einer Wiederholung prüfen.",
      );
    }
    void response.body?.cancel().catch(() => {});
    this.checkResponse(response);
    return response.headers.get("etag");
  }
  private async loadSingle(ref: CalendarRef) {
    if (!strongEtag(ref.etag))
      return fail("INVALID_CALENDAR_REFERENCE", "Starker ETag erforderlich.");
    const c = this.source(ref.calendar);
    const url = this.resource(this.collection(c.url), ref.href);
    const response = await this.request(c, url.href, {
      method: "GET",
      headers: { "If-Match": ref.etag },
    });
    this.checkResponse(response);
    if (response.headers.get("etag") !== ref.etag)
      return fail(
        "CALENDAR_CONFLICT",
        "ETag stimmt nicht überein; Termin neu laden.",
      );
    const event = singleEvent(await boundedText(response));
    if (!event)
      return fail(
        "UNSUPPORTED_CALENDAR_RESOURCE",
        "Nur eigenständige Einzeltermine können bearbeitet werden.",
      );
    if (event.uid !== ref.uid)
      return fail(
        "INVALID_CALENDAR_REFERENCE",
        "Termin-ID stimmt nicht überein.",
      );
    return { c, url, event };
  }
  async create(calendar: string, fields: CalendarFields) {
    const c = this.source(calendar);
    const uid = randomUUID();
    const url = this.resource(this.collection(c.url), uid + ".ics");
    const etag = await this.write(c, url, {
      method: "PUT",
      headers: {
        "If-None-Match": "*",
        "Content-Type": "text/calendar; charset=utf-8",
      },
      body: newEvent(uid, fields),
    });
    return {
      ref: {
        calendar,
        href: url.pathname,
        uid,
        ...(strongEtag(etag) && { etag }),
      },
    };
  }
  async update(ref: CalendarRef, fields: Partial<CalendarFields>) {
    const { c, url, event } = await this.loadSingle(ref);
    const etag = await this.write(c, url, {
      method: "PUT",
      headers: {
        "If-Match": ref.etag,
        "Content-Type": "text/calendar; charset=utf-8",
      },
      body: editEvent(event, fields),
    });
    return {
      ref: {
        calendar: ref.calendar,
        href: url.pathname,
        uid: ref.uid,
        ...(strongEtag(etag) && { etag }),
      },
    };
  }
  async remove(ref: CalendarRef) {
    const { c, url } = await this.loadSingle(ref);
    await this.write(c, url, {
      method: "DELETE",
      headers: { "If-Match": ref.etag },
    });
    return { deleted: true };
  }
  async events(
    calendar: string,
    from: string,
    to: string,
    limit: number,
    cursor?: string,
  ) {
    range(from, to);
    const c = this.source(calendar);
    const stamp = (s: string) =>
      new Date(s).toISOString().replace(/[-:]/g, "").replace(".000", "");
    const body = `<?xml version="1.0" encoding="UTF-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const response = await this.request(c, c.url, {
      method: "REPORT",
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1",
      },
      body,
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
        const etag = good
          .map((p) => p.prop?.getetag?.trim?.())
          .find(strongEtag);
        const editable = etag && singleEvent(ics);
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
              ...(editable && { etag }),
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
