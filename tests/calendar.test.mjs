import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expandSafe, CalendarService, boundedText } from "../dist/calendar.js";
const ics = readFileSync(
  new URL("./fixtures/calendar.ics", import.meta.url),
  "utf8",
);
const from = "2026-03-27T00:00:00Z",
  to = "2026-04-01T00:00:00Z";
const config = {
  displayTimezone: "Europe/Berlin",
  calendars: [
    {
      id: "private",
      url: "https://example.invalid/cal/",
      username: "user",
      password: "secret",
    },
  ],
};
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const response = (extra = "") =>
  new Response(
    `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/a.ics</d:href><d:propstat><d:prop><c:calendar-data>${escape(ics)}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${extra}</d:multistatus>`,
    { status: 207 },
  );
test("calendar expands DST, EXDATE, moved exception, cancellation, all-day and floating times", async () => {
  const rows = await expandSafe(ics, from, to, "Europe/Berlin");
  const series = rows.filter((x) => x.uid === "series");
  assert.equal(series.length, 4);
  assert.equal(series[0].start, "2026-03-27T08:00:00.000Z");
  assert.equal(series[1].start, "2026-03-29T07:00:00.000Z");
  assert.equal(series[2].start, "2026-03-30T09:00:00.000Z");
  assert.equal(series[2].title, "Verschoben");
  assert.equal(series[3].cancelled, true);
  const all = rows.find((x) => x.uid === "allday");
  assert.equal(all.start, "2026-03-28");
  assert.equal(all.end, "2026-03-31");
  assert.equal(all.allDay, true);
  assert.equal(
    rows.find((x) => x.uid === "floating").start,
    "2026-03-29T12:00:00.000Z",
  );
});
test("ongoing events included; right boundary excluded", async () => {
  const rows = await expandSafe(
    ics,
    "2026-03-29T07:30:00Z",
    "2026-03-30T09:00:00Z",
    "Europe/Berlin",
  );
  assert(rows.some((x) => x.uid === "allday"));
  assert(rows.some((x) => x.start === "2026-03-29T07:00:00.000Z"));
  assert(!rows.some((x) => x.title === "Verschoben"));
});
test("CalDAV REPORT is read-only, pagination is bounded and query-bound", async () => {
  const service = new CalendarService(config, async (url, opts) => {
    assert.equal(opts.method, "REPORT");
    assert.equal(opts.redirect, "error");
    assert.match(opts.body, /calendar-query/);
    return response();
  });
  const a = await service.events("private", from, to, 2);
  assert.equal(a.items.length, 2);
  assert.equal(a.complete, true);
  assert(a.nextCursor);
  const b = await service.events("private", from, to, 2, a.nextCursor);
  assert.notDeepEqual(a.items, b.items);
  await assert.rejects(
    service.events("private", "2026-03-28T00:00:00Z", to, 2, a.nextCursor),
    { code: "STALE_CURSOR" },
  );
});
test("individual resource errors preserve successful data and report incomplete", async () => {
  const service = new CalendarService(config, async () =>
    response(
      "<d:response><d:href>/bad</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>",
    ),
  );
  const r = await service.events("private", from, to, 25);
  assert(r.items.length > 0);
  assert.equal(r.complete, false);
  assert.equal(r.errors.length, 1);
});
test("HTTP/auth, malformed XML, unavailable and size errors are not empty results", async () => {
  for (const f of [
    async () => new Response("secret", { status: 401 }),
    async () => new Response("<x>", { status: 207 }),
    async () => {
      throw Error("secret");
    },
  ])
    await assert.rejects(
      new CalendarService(config, f).events("private", from, to, 25),
    );
  await assert.rejects(boundedText(new Response("123456"), 5), {
    code: "RESPONSE_TOO_LARGE",
  });
});
test("CRLF floating times retain configured zone", async () => {
  const rows = await expandSafe(
    ics.replaceAll("\n", "\r\n"),
    from,
    to,
    "Europe/Berlin",
  );
  assert.equal(
    rows.find((x) => x.uid === "floating").start,
    "2026-03-29T12:00:00.000Z",
  );
});
test("RDATE without RRULE, EXDATE and duplicate dates form correct occurrence set", async () => {
  const data =
    "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:rdate\nDTSTART;TZID=Europe/Berlin:20260327T090000\nDTEND;TZID=Europe/Berlin:20260327T100000\nRDATE;TZID=Europe/Berlin:20260327T090000,20260328T090000,20260329T090000\nEXDATE;TZID=Europe/Berlin:20260328T090000\nSUMMARY:Zusatztermine\nEND:VEVENT\nEND:VCALENDAR";
  const rows = await expandSafe(data, from, to, "Europe/Berlin");
  assert.deepEqual(
    rows.map((x) => x.start),
    ["2026-03-27T08:00:00.000Z", "2026-03-29T07:00:00.000Z"],
  );
});
test("recurring all-day dates stay stable across DST", async () => {
  const data =
    "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:daily\nDTSTART;VALUE=DATE:20260328\nDTEND;VALUE=DATE:20260329\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Tag\nEND:VEVENT\nEND:VCALENDAR";
  const rows = await expandSafe(data, from, to, "Europe/Berlin");
  assert.deepEqual(
    rows.map((x) => [x.start, x.end]),
    [
      ["2026-03-28", "2026-03-29"],
      ["2026-03-29", "2026-03-30"],
      ["2026-03-30", "2026-03-31"],
    ],
  );
});
test("valid empty multistatus is an explicitly successful empty calendar", async () => {
  const service = new CalendarService(
    config,
    async () =>
      new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }),
  );
  const r = await service.events("private", from, to, 25);
  assert.deepEqual(r.items, []);
  assert.equal(r.complete, true);
});
test("unsupported timezone and range overrides fail visibly", async () => {
  await assert.rejects(
    expandSafe(
      ics.replaceAll("Europe/Berlin", "Unknown/Nowhere"),
      from,
      to,
      "Europe/Berlin",
    ),
  );
  await assert.rejects(
    expandSafe(
      ics.replace(
        "RECURRENCE-ID;TZID",
        "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID",
      ),
      from,
      to,
      "Europe/Berlin",
    ),
  );
});
