import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import {
  decode,
  encode,
  fail,
  range,
  safeError,
  type MailRef,
} from "./common.js";
import { Journal, type Action } from "./journal.js";
export async function parseMail(source: Buffer) {
  const p = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const text =
    p.text ||
    (p.html
      ? convert(p.html, {
          wordwrap: false,
          selectors: [{ selector: "img", format: "skip" }],
        })
      : "");
  return {
    messageId: p.messageId,
    from: p.from?.text ?? "",
    to:
      (Array.isArray(p.to) ? p.to.map((x) => x.text).join(", ") : p.to?.text) ??
      "",
    cc:
      (Array.isArray(p.cc) ? p.cc.map((x) => x.text).join(", ") : p.cc?.text) ??
      "",
    subject: p.subject ?? "",
    date: p.date?.toISOString(),
    text,
    attachments: p.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      contentId: a.contentId,
    })),
  };
}
export type ClientFactory = (
  options: ConstructorParameters<typeof ImapFlow>[0],
) => ImapFlow;
export class MailService {
  constructor(
    private config: Config,
    private journal: Journal,
    private factory: ClientFactory = (options) => new ImapFlow(options),
  ) {}
  private account(id: string) {
    return (
      this.config.mail.find((a) => a.id === id) ??
      fail("UNKNOWN_ACCOUNT", "Unbekanntes Postfach.")
    );
  }
  private async connect<T>(
    id: string,
    work: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const a = this.account(id);
    const c = this.factory({
      host: a.host,
      port: a.port,
      secure: true,
      auth: { user: a.username, pass: a.password },
      tls: { rejectUnauthorized: true },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    c.on("error", () => {});
    try {
      await c.connect();
      return await work(c);
    } finally {
      c.close();
    }
  }
  private valid(c: ImapFlow, ref: MailRef) {
    if (!c.mailbox || String(c.mailbox.uidValidity) !== ref.uidValidity)
      fail("STALE_REFERENCE", "UIDVALIDITY geändert; Nachricht erneut suchen.");
  }
  async folders(account: string, limit: number, cursor?: string) {
    return this.connect(account, async (c) => {
      const rows = (await c.list())
        .map((x) => ({
          path: x.path,
          specialUse: x.specialUse,
          selectable: !x.flags.has("\\Noselect"),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const offset = cursor
        ? decode<{ account: string; offset: number }>(cursor)
        : { account, offset: 0 };
      if (
        offset.account !== account ||
        !Number.isSafeInteger(offset.offset) ||
        offset.offset < 0
      )
        fail("INVALID_CURSOR", "Cursor passt nicht zur Abfrage.");
      return {
        items: rows.slice(offset.offset, offset.offset + limit),
        complete: true,
        nextCursor:
          rows.length > offset.offset + limit
            ? encode({ account, offset: offset.offset + limit })
            : null,
      };
    });
  }
  async read(ref: MailRef, offset = 0, maxChars = 12000) {
    return this.connect(ref.account, async (c) => {
      const lock = await c.getMailboxLock(ref.folder, { readOnly: true });
      try {
        this.valid(c, ref);
        const meta = await c.fetchOne(
          String(ref.uid),
          { size: true },
          { uid: true },
        );
        if (!meta) return fail("NOT_FOUND", "Nachricht nicht mehr vorhanden.");
        if ((meta.size ?? Infinity) > 10 * 1024 * 1024)
          fail(
            "MESSAGE_TOO_LARGE",
            "Nachricht überschreitet das MIME-Limit von 10 MiB.",
          );
        const row = await c.fetchOne(
          String(ref.uid),
          {
            source: { maxLength: 10 * 1024 * 1024 + 1 },
            flags: true,
            internalDate: true,
          },
          { uid: true },
        );
        if (!row || !row.source)
          return fail("NOT_FOUND", "Nachricht nicht mehr vorhanden.");
        if (row.source.length > 10 * 1024 * 1024)
          fail(
            "MESSAGE_TOO_LARGE",
            "Nachricht überschreitet das MIME-Limit von 10 MiB.",
          );
        const p = await parseMail(row.source);
        return {
          ...p,
          ref,
          flags: [...(row.flags ?? [])],
          receivedAt:
            row.internalDate instanceof Date
              ? row.internalDate.toISOString()
              : row.internalDate,
          text: p.text.slice(offset, offset + maxChars),
          textLength: p.text.length,
          nextOffset:
            offset + maxChars < p.text.length ? offset + maxChars : null,
          complete: true,
          untrustedContent: true,
        };
      } finally {
        lock.release();
      }
    });
  }
  async search(
    account: string,
    folder: string,
    from: string | undefined,
    to: string | undefined,
    limit: number,
    cursor?: string,
    readStatus: "all" | "unread" | "read" = "all",
  ) {
    if ((from === undefined) !== (to === undefined))
      fail(
        "INVALID_RANGE",
        "from und to müssen gemeinsam angegeben oder gemeinsam weggelassen werden.",
      );
    if (from === undefined && readStatus !== "unread")
      fail(
        "MISSING_RANGE",
        "Ohne Zeitraum ist nur readStatus=unread zulässig.",
      );
    const dates =
      from !== undefined && to !== undefined ? range(from, to) : undefined;
    const query = createHash("sha256")
      .update(JSON.stringify({ account, folder, from, to, readStatus }))
      .digest("hex");
    return this.connect(account, async (c) => {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        if (!c.mailbox) return fail("MAILBOX", "Ordner nicht geöffnet.");
        const uidValidity = String(c.mailbox.uidValidity);
        let before = 0x100000000; // IMAP UIDs are unsigned 32-bit integers.
        if (cursor) {
          const p = decode<{
            query: string;
            uidValidity: string;
            before: number;
          }>(cursor);
          if (
            p.query !== query ||
            p.uidValidity !== uidValidity ||
            !Number.isSafeInteger(p.before) ||
            p.before < 1 ||
            p.before > 0x100000000
          )
            fail(
              "INVALID_CURSOR",
              "Cursor veraltet oder passt nicht zur Abfrage.",
            );
          before = p.before;
        }
        // Force absolute date criteria. ImapFlow's WITHIN shortcut turns future
        // BEFORE values into OLDER 0, which Dovecot rejects (and clamps future SINCE).
        c.capabilities.delete("WITHIN");
        // IMAP SINCE/BEFORE are day-granular; filter INTERNALDATE exactly below.
        const criteria: {
          since?: Date;
          before?: Date;
          uid: string;
          seen?: boolean;
        } = {
          uid: `1:${Math.max(1, before - 1)}`,
        };
        if (dates) {
          criteria.since = new Date(+dates.from - 86400000);
          criteria.before = new Date(+dates.to + 86400000);
        }
        if (readStatus !== "all") criteria.seen = readStatus === "read";
        const ids = await c.search(criteria, { uid: true });
        if (!Array.isArray(ids))
          return fail(
            "SEARCH_FAILED",
            "IMAP-Suche fehlgeschlagen; kein leeres Ergebnis.",
          );
        const candidates = ids.filter((x) => x < before).sort((a, b) => b - a);
        const items: unknown[] = [];
        const errors: unknown[] = [];
        let scanned = 0;
        for (const uid of candidates) {
          if (items.length >= limit || scanned >= 500) break;
          scanned++;
          before = uid;
          const row = await c.fetchOne(
            String(uid),
            { envelope: true, internalDate: true, flags: true, size: true },
            { uid: true },
          );
          if (!row) {
            errors.push({ uid, code: "VANISHED" });
            continue;
          }
          const received = new Date(row.internalDate as Date);
          if (!Number.isFinite(+received)) {
            errors.push({ uid, code: "INVALID_DATE" });
            continue;
          }
          if (dates && (+received < +dates.from || +received >= +dates.to))
            continue;
          const ref = { account, folder, uidValidity, uid };
          let excerpt: string | null = null;
          if ((row.size ?? Infinity) <= 10 * 1024 * 1024) {
            const body = await c.fetchOne(
              String(uid),
              { source: { maxLength: 10 * 1024 * 1024 + 1 } },
              { uid: true },
            );
            if (body && body.source) {
              try {
                if (body.source.length > 10 * 1024 * 1024)
                  fail("MESSAGE_TOO_LARGE", "MIME-Limit überschritten.");
                excerpt = (await parseMail(body.source)).text.slice(0, 500);
              } catch {
                errors.push({ uid, code: "MIME_ERROR" });
              }
            } else errors.push({ uid, code: "VANISHED" });
          } else errors.push({ uid, code: "MESSAGE_TOO_LARGE" });
          items.push({
            ref,
            subject: row.envelope?.subject,
            from: row.envelope?.from,
            to: row.envelope?.to,
            date: row.envelope?.date
              ? new Date(row.envelope.date).toISOString()
              : undefined,
            receivedAt: received.toISOString(),
            flags: [...(row.flags ?? [])],
            excerpt,
          });
        }
        return {
          items,
          errors,
          complete: errors.length === 0,
          readStatus,
          timeRange: dates ? { from, to } : null,
          untrustedContent: true,
          nextCursor:
            scanned < candidates.length
              ? encode({ query, uidValidity, before })
              : null,
        };
      } finally {
        lock.release();
      }
    });
  }
  async quarantine(ref: MailRef, actionId: string, reason: string) {
    const target = this.account(ref.account).quarantineFolder;
    if (target === ref.folder)
      fail(
        "ALREADY_QUARANTINED",
        "Nachricht liegt bereits im Aussortierordner.",
      );
    return this.move({
      id: actionId,
      kind: "quarantine",
      source: ref,
      target,
      reason,
      state: "pending",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });
  }
  async restore(parentId: string, actionId: string, reason: string) {
    const parent = this.journal.get(parentId);
    if (
      !parent ||
      parent.kind !== "quarantine" ||
      parent.state !== "completed" ||
      !parent.destination
    )
      return fail(
        "NOT_RESTORABLE",
        "Nur eindeutig abgeschlossene Aussortierungen können automatisch wiederhergestellt werden.",
      );
    return this.move({
      id: actionId,
      kind: "restore",
      source: parent.destination,
      target: parent.source.folder,
      parent: parentId,
      reason,
      state: "pending",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });
  }
  private async move(input: Action): Promise<Action> {
    const begun = this.journal.begin(input);
    if (!begun.fresh) return begun.action;
    const action = begun.action;
    let sent = false;
    try {
      await this.connect(action.source.account, async (c) => {
        const lock = await c.getMailboxLock(action.source.folder);
        try {
          this.valid(c, action.source);
          if (!c.capabilities.has("MOVE") || !c.capabilities.has("UIDPLUS"))
            fail(
              "UNSUPPORTED_MOVE",
              "Server muss MOVE und UIDPLUS unterstützen.",
            );
          const found = await c.fetchOne(
            String(action.source.uid),
            { uid: true },
            { uid: true },
          );
          if (!found) fail("NOT_FOUND", "Nachricht nicht mehr vorhanden.");
          const folders = await c.list();
          if (!folders.some((f) => f.path === action.target)) {
            if (action.kind === "restore")
              fail("MISSING_FOLDER", "Ursprünglicher Ordner fehlt.");
            await c.mailboxCreate(action.target);
          }
          sent = true;
          const result = await c.messageMove(
            String(action.source.uid),
            action.target,
            { uid: true },
          );
          if (
            !result ||
            !result.uidValidity ||
            !result.uidMap?.get(action.source.uid)
          )
            return fail(
              "MISSING_MOVE_REFERENCE",
              "MOVE-Ergebnis enthält keine eindeutige Zielreferenz.",
            );
          action.destination = {
            account: action.source.account,
            folder: action.target,
            uidValidity: String(result.uidValidity),
            uid: result.uidMap.get(action.source.uid)!,
          };
          action.state = "completed";
          this.journal.save(action);
        } finally {
          lock.release();
        }
      });
    } catch (error) {
      action.state = sent ? "uncertain" : "failed";
      action.error = sent ? "MOVE_OUTCOME_UNKNOWN" : safeError(error).code;
      this.journal.save(action);
    }
    return action;
  }
}
