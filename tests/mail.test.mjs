import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MailService, parseMail } from "../dist/mail.js";
import { Journal } from "../dist/journal.js";
const source = readFileSync(new URL("./fixtures/message.eml", import.meta.url));
const ref = { account: "test", folder: "INBOX", uidValidity: "10", uid: 3 };
function setup(t) {
  const path = join(mkdtempSync(join(tmpdir(), "pim-mail-")), "journal.sqlite");
  const journal = new Journal(path);
  t.after(() => journal.close());
  const config = {
    mail: [
      {
        id: "test",
        host: "example.invalid",
        port: 993,
        username: "x",
        password: "secret",
        quarantineFolder: "PIM – Aussortiert",
      },
    ],
    calendars: [],
    displayTimezone: "Europe/Berlin",
    statePath: path,
  };
  const state = {
    moves: 0,
    mode: "ok",
    flags: new Set(),
    rows: new Map(
      [1, 2, 3].map((uid) => [
        uid,
        {
          uid,
          size: source.length,
          source,
          internalDate: new Date(`2026-09-11T0${uid}:00:00Z`),
          flags: new Set(),
          envelope: { subject: "Test" },
        },
      ]),
    ),
    capabilities: new Set(["MOVE", "UIDPLUS"]),
  };
  const factory = (options) => {
    assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.logger, false);
    return {
      on() {},
      connect: async () => {
        if (state.mode === "offline") throw new Error("secret");
      },
      close() {},
      capabilities: state.capabilities,
      mailbox: { uidValidity: 10n },
      getMailboxLock: async (folder, opts) => {
        state.lock = { folder, opts };
        return { release() {} };
      },
      list: async () => [
        { path: "INBOX", flags: new Set() },
        { path: "PIM – Aussortiert", flags: new Set() },
      ],
      search: async (criteria) => {
        state.lastSearch = criteria;
        return [...state.rows.entries()]
          .filter(([, row]) =>
            criteria.seen === undefined
              ? true
              : row.flags.has("\\Seen") === criteria.seen,
          )
          .map(([uid]) => uid);
      },
      fetchOne: async (uid, query, options) => {
        assert.equal(options.uid, true);
        assert.equal(query.markSeen, undefined);
        return state.rows.get(Number(uid)) ?? false;
      },
      messageMove: async (uid, target, opts) => {
        assert.equal(opts.uid, true);
        state.moves++;
        if (state.mode === "disconnect") throw new Error("socket secret");
        if (state.mode === "nomap") return {};
        return { uidValidity: 20n, uidMap: new Map([[Number(uid), 50]]) };
      },
    };
  };
  return {
    journal,
    state,
    mail: new MailService(config, journal, factory),
    path,
  };
}
test("MIME decodes charset and HTML, metadata only for attachment", async () => {
  const p = await parseMail(source);
  assert.match(p.from, /Jürgen/);
  assert.equal(p.subject, "Prüfung");
  assert.match(p.text, /Grüße/);
  assert.doesNotMatch(p.text, /evil|pixel/);
  assert.equal(p.attachments[0].filename, "notiz.txt");
  assert.equal(p.attachments[0].size, 5);
  assert.equal(p.attachments[0].content, undefined);
});
test("read uses read-only lock, retains flags and supports complete text pagination", async (t) => {
  const { mail, state } = setup(t);
  const first = await mail.read(ref, 0, 5);
  const rest = await mail.read(ref, first.nextOffset, 30000);
  assert.equal(first.text + rest.text, (await parseMail(source)).text);
  assert.equal(state.lock.opts.readOnly, true);
  assert.deepEqual(first.flags, []);
  assert.equal(rest.nextOffset, null);
  await assert.rejects(mail.read({ ...ref, uidValidity: "9" }), {
    code: "STALE_REFERENCE",
  });
});
test("search pagination excludes later arrivals, keeps exact time boundaries", async (t) => {
  const { mail, state } = setup(t);
  const args = [
    "test",
    "INBOX",
    "2026-09-11T01:00:00Z",
    "2026-09-11T03:00:00Z",
    1,
  ];
  const a = await mail.search(...args);
  assert.equal(a.items[0].ref.uid, 2);
  state.rows.set(4, { ...state.rows.get(1), uid: 4 });
  const b = await mail.search(...args, a.nextCursor);
  assert.equal(b.items[0].ref.uid, 1);
  assert.equal(b.nextCursor, null);
  assert.equal(a.complete, true);
  await assert.rejects(
    mail.search("test", "Other", args[2], args[3], 1, a.nextCursor),
    { code: "INVALID_CURSOR" },
  );
});
test("search filters unread/read server-side and binds status to cursor", async (t) => {
  const { mail, state } = setup(t);
  state.rows.get(1).flags.add("\\Seen");
  const args = [
    "test",
    "INBOX",
    "2026-09-11T00:00:00Z",
    "2026-09-12T00:00:00Z",
    1,
  ];

  const unread = await mail.search(...args, undefined, "unread");
  assert.equal(state.lastSearch.seen, false);
  assert.equal(unread.readStatus, "unread");
  assert.equal(unread.items[0].ref.uid, 3);
  assert(unread.nextCursor);

  const read = await mail.search(...args, undefined, "read");
  assert.equal(state.lastSearch.seen, true);
  assert.deepEqual(
    read.items.map((item) => item.ref.uid),
    [1],
  );

  const all = await mail.search(...args);
  assert.equal(state.lastSearch.seen, undefined);
  assert.equal(all.readStatus, "all");

  await assert.rejects(mail.search(...args, unread.nextCursor, "all"), {
    code: "INVALID_CURSOR",
  });
});
test("unread search works without time range while other modes stay bounded", async (t) => {
  const { mail, state } = setup(t);
  state.rows.get(1).flags.add("\\Seen");

  const unread = await mail.search(
    "test",
    "INBOX",
    undefined,
    undefined,
    25,
    undefined,
    "unread",
  );
  assert.equal(state.lastSearch.seen, false);
  assert.equal(state.lastSearch.since, undefined);
  assert.equal(state.lastSearch.before, undefined);
  assert.equal(unread.timeRange, null);
  assert.deepEqual(
    unread.items.map((item) => item.ref.uid),
    [3, 2],
  );

  await assert.rejects(mail.search("test", "INBOX", undefined, undefined, 25), {
    code: "MISSING_RANGE",
  });
  await assert.rejects(
    mail.search(
      "test",
      "INBOX",
      "2026-09-11T00:00:00Z",
      undefined,
      25,
      undefined,
      "unread",
    ),
    { code: "INVALID_RANGE" },
  );
});
test("move is durable and idempotent across journal instances; restore maps new UID", async (t) => {
  const { mail, journal, state, path } = setup(t);
  const id = randomUUID();
  const a = await mail.quarantine(ref, id, "Werbung");
  assert.equal(a.state, "completed");
  assert.equal(a.destination.uid, 50);
  assert.deepEqual(await mail.quarantine(ref, id, "Werbung"), a);
  assert.equal(state.moves, 1);
  const reopened = new Journal(path);
  assert.equal(reopened.get(id).state, "completed");
  reopened.close();
  await assert.rejects(mail.quarantine(ref, randomUUID(), "Werbung"), {
    code: "ACTION_EXISTS",
  });
  await assert.rejects(mail.quarantine(ref, id, "Andere Begründung"), {
    code: "ACTION_CONFLICT",
  });
  state.rows.set(50, state.rows.get(3));
  // A new connection to destination has its own UIDVALIDITY.
  mail.factory = (opts) => {
    const c = {
      on() {},
      connect: async () => {},
      close() {},
      capabilities: state.capabilities,
      mailbox: { uidValidity: 20n },
      getMailboxLock: async () => ({ release() {} }),
      fetchOne: async () => ({ uid: 50 }),
      list: async () => [{ path: "INBOX" }],
      messageMove: async () => {
        state.moves++;
        return { uidValidity: 10n, uidMap: new Map([[50, 80]]) };
      },
    };
    return c;
  };
  const restored = await mail.restore(id, randomUUID(), "Zurück");
  assert.equal(restored.state, "completed");
  assert.equal(restored.destination.uid, 80);
  assert.equal(restored.destination.folder, "INBOX");
  assert.equal(journal.list(0, 10).items.length, 2);
});
for (const mode of ["disconnect", "nomap"])
  test(`uncertain move (${mode}) is never retried`, async (t) => {
    const { mail, state } = setup(t);
    state.mode = mode;
    const id = randomUUID();
    assert.equal(
      (await mail.quarantine(ref, id, "Werbung")).state,
      "uncertain",
    );
    await mail.quarantine(ref, id, "Werbung");
    assert.equal(state.moves, 1);
    await assert.rejects(mail.quarantine(ref, randomUUID(), "Werbung"), {
      code: "ACTION_EXISTS",
    });
    await assert.rejects(mail.restore(id, randomUUID(), "Zurück"), {
      code: "NOT_RESTORABLE",
    });
  });
test("pending journal entry prevents duplicate action after abrupt process loss", async (t) => {
  const { journal, mail, state } = setup(t);
  const id = randomUUID();
  journal.begin({
    id,
    kind: "quarantine",
    source: ref,
    target: "PIM – Aussortiert",
    reason: "Werbung",
    state: "pending",
    created: "now",
    updated: "now",
  });
  assert.equal((await mail.quarantine(ref, id, "Werbung")).state, "pending");
  assert.equal(state.moves, 0);
});
test("unsupported server never attempts fallback COPY/delete/EXPUNGE", async (t) => {
  const { mail, state } = setup(t);
  state.capabilities.clear();
  assert.equal(
    (await mail.quarantine(ref, randomUUID(), "Werbung")).state,
    "failed",
  );
  assert.equal(state.moves, 0);
});
test("offline source throws, oversized MIME makes search explicitly incomplete", async (t) => {
  const { mail, state } = setup(t);
  state.mode = "offline";
  await assert.rejects(mail.read(ref));
  state.mode = "ok";
  state.rows.get(3).size = 11000000;
  const result = await mail.search(
    "test",
    "INBOX",
    "2026-09-11T00:00:00Z",
    "2026-09-12T00:00:00Z",
    25,
  );
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].code, "MESSAGE_TOO_LARGE");
});

test("search uses valid 32-bit UID range and rejects server failure", async (t) => {
  const { mail } = setup(t);
  const original = mail.factory;
  mail.factory = (options) => {
    const c = original(options);
    c.capabilities.add("WITHIN");
    c.search = async (query) => {
      assert.equal(c.capabilities.has("WITHIN"), false);
      assert.equal(query.uid, "1:4294967295");
      return false;
    };
    return c;
  };
  await assert.rejects(
    mail.search(
      "test",
      "INBOX",
      "2026-09-10T00:00:00Z",
      "2026-09-12T00:00:00Z",
      25,
    ),
    { code: "SEARCH_FAILED" },
  );
});
