import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../dist/mail.js";
import { Journal } from "../dist/journal.js";
import { CalendarService } from "../dist/calendar.js";
import { composeMail } from "../dist/smtp.js";

test("MIME reply includes the original Message-ID without disclosing Bcc", async () => {
  const mime = await composeMail("me@example.test", {
    to: ["recipient@example.test"],
    bcc: ["hidden@example.test"],
    subject: "Re: Hello",
    text: "Reply",
    messageId: "<reply@example.test>",
    inReplyTo: "<original@example.test>",
  });
  assert.match(mime.toString(), /In-Reply-To: <original@example.test>/i);
  assert.match(mime.toString(), /References: <original@example.test>/i);
  assert.doesNotMatch(mime.toString(), /hidden@example.test/);
});

test("SMTP selects the mailbox, stores partial acceptance and never resends an action", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pim-send-"));
  const journal = new Journal(join(dir, "journal.db"));
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const smtp = {
    host: "smtp.example.test",
    port: 587,
    tls: "starttls",
    username: "smtp-user",
    password: "secret",
    from: "me@example.test",
    sentFolder: "Sent Items",
  };
  const account = {
    id: "box",
    host: "imap.example.test",
    username: "imap-user",
    smtp,
  };
  const input = {
    account: account.id,
    actionId: randomUUID(),
    to: ["good@example.test", "bad@example.test"],
    bcc: ["hidden@example.test"],
    subject: "Hello",
    text: "Private body",
  };
  let sends = 0;
  let appended = 0;
  let failCopy = false;
  let uncertain = false;
  const service = new MailService(
    { mail: [{ ...account, id: "other", smtp: undefined }, account] },
    journal,
    (options) => ({
      on() {},
      connect() {},
      close() {},
      async append(folder, raw, flags) {
        appended++;
        assert.equal(options.auth.user, "imap-user");
        assert.equal(folder, smtp.sentFolder);
        assert.deepEqual(flags, ["\\Seen"]);
        assert.doesNotMatch(raw.toString(), /Bcc:|hidden@example.test/i);
        if (failCopy) throw new Error("IMAP error");
        return { uid: 10 };
      },
    }),
    async (selected, raw, message) => {
      sends++;
      assert.equal(selected, smtp);
      assert.match(raw.toString(), /Private body/);
      assert.deepEqual(message.bcc, input.bcc);
      if (uncertain) throw new Error("Socket closed");
      return { accepted: [input.to[0]], rejected: [input.to[1]] };
    },
  );
  const result = await service.send(input);
  assert.equal(result.state, "completed");
  assert.equal(result.copy, "saved");
  assert.deepEqual(result.rejected, [input.to[1]]);
  assert.equal((await service.send(input)).copy, "saved");
  assert.equal(sends, 1);
  failCopy = true;
  const copyError = await service.send({ ...input, actionId: randomUUID() });
  assert.equal(copyError.state, "completed");
  assert.equal(copyError.copy, "failed");
  uncertain = true;
  const interrupted = { ...input, actionId: randomUUID() };
  assert.equal((await service.send(interrupted)).state, "uncertain");
  assert.equal((await service.send(interrupted)).state, "uncertain");
  assert.equal(sends, 3);
  assert.equal(appended, 2);
  assert.doesNotMatch(
    JSON.stringify(journal.list(0, 10)),
    /Private body|good@example.test|secret/,
  );
});

test("CalDAV creates, moves and deletes a single event conditionally", async () => {
  let ics;
  let etag;
  const calls = [];
  const calendar = new CalendarService(
    {
      calendars: [
        {
          id: "personal",
          url: "https://calendar.example.test/cal/",
          username: "a",
          password: "b",
        },
      ],
    },
    async (url, options) => {
      calls.push([url, options]);
      if (options.method === "GET")
        return new Response(ics, { headers: { etag } });
      if (options.method === "DELETE")
        return new Response(null, { status: 204 });
      ics = options.body;
      etag = etag ? '"second"' : '"first"';
      return new Response(null, { status: 201, headers: { etag } });
    },
  );
  const { ref } = await calendar.create("personal", {
    title: "Tag; 1",
    start: "2026-12-05",
    end: "2026-12-06",
    location: "Berlin",
  });
  assert.equal(calls[0][1].headers["If-None-Match"], "*");
  assert.match(ics, /DTSTART;VALUE=DATE:20261205/);
  assert.match(ics, /SUMMARY:Tag\\; 1/);
  ics = ics.replace("END:VEVENT", "X-EXAMPLE:keep\r\nEND:VEVENT");
  const updated = await calendar.update(ref, {
    start: "2026-12-12T09:00:00+01:00",
    end: "2026-12-12T10:00:00+01:00",
  });
  assert.equal(updated.ref.href, ref.href);
  assert.equal(updated.ref.uid, ref.uid);
  assert.equal(calls[2][1].headers["If-Match"], '"first"');
  assert.match(ics, /DTSTART:20261212T080000Z/);
  assert.match(ics, /X-EXAMPLE:keep/);
  await assert.rejects(calendar.remove(ref), { code: "CALENDAR_CONFLICT" });
  const count = calls.length;
  await assert.rejects(
    calendar.remove({
      ...updated.ref,
      href: "https://wrong.example.test/a.ics",
    }),
    { code: "INVALID_CALENDAR_REFERENCE" },
  );
  assert.equal(calls.length, count);
  ics = ics.replace("END:VEVENT", "RRULE:FREQ=DAILY\r\nEND:VEVENT");
  await assert.rejects(calendar.remove(updated.ref), {
    code: "UNSUPPORTED_CALENDAR_RESOURCE",
  });
  ics = ics.replace("RRULE:FREQ=DAILY\r\n", "");
  assert.deepEqual(await calendar.remove(updated.ref), { deleted: true });
  assert.equal(calls.at(-1)[1].headers["If-Match"], '"second"');
});

test("CalDAV reports known 403 reasons without exposing the server body", async () => {
  const calendar = new CalendarService(
    {
      calendars: [
        {
          id: "Privat",
          url: "https://calendar.example.test/cal/",
          username: "a",
          password: "b",
        },
      ],
    },
    async () => new Response(body, { status: 403 }),
  );
  let body;
  for (const [response, message] of [
    [
      '<d:error xmlns:d="DAV:"><d:need-privileges>private</d:need-privileges></d:error>',
      "HTTP 403. Der CalDAV-Server meldet fehlende Rechte für die Aktion.",
    ],
    [
      '<d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:valid-calendar-data/></d:error>',
      "HTTP 403. Der CalDAV-Server meldet ungültige iCalendar-Daten.",
    ],
    ["private proxy error", "CalDAV-Aktion fehlgeschlagen (HTTP 403)."],
  ]) {
    body = response;
    await assert.rejects(
      calendar.create("Privat", {
        title: "Termin",
        start: "2026-11-27T17:00:00+01:00",
        end: "2026-11-27T22:00:00+01:00",
      }),
      { code: "CALDAV_HTTP", message },
    );
  }
});

test("CalDAV exposes a writable ETag for a single event beyond seven days", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:demo",
    "DTSTART:20261212T080000Z",
    "DTEND:20261212T090000Z",
    "SUMMARY:Demo",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const calendar = new CalendarService(
    {
      displayTimezone: "Europe/Berlin",
      calendars: [
        {
          id: "personal",
          url: "https://calendar.example.test/cal/",
          username: "a",
          password: "b",
        },
      ],
    },
    async () =>
      new Response(
        '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
          "<d:response><d:href>/cal/demo.ics</d:href><d:propstat><d:prop>" +
          "<d:getetag>&quot;test&quot;</d:getetag><c:calendar-data>" +
          ics +
          "</c:calendar-data>" +
          "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>",
        { status: 207 },
      ),
  );
  const result = await calendar.events(
    "personal",
    "2026-12-01T00:00:00Z",
    "2026-12-15T00:00:00Z",
    25,
  );
  assert.equal(result.complete, true);
  assert.equal(result.items[0].ref.etag, '"test"');
});
