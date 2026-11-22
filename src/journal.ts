import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { fail, type MailRef } from "./common.js";
export interface Action {
  id: string;
  kind: "quarantine" | "restore";
  source: MailRef;
  target: string;
  reason: string;
  parent?: string;
  destination?: MailRef;
  state: "pending" | "completed" | "uncertain" | "failed";
  created: string;
  updated: string;
  error?: string;
}
export interface SendAction {
  id: string;
  kind: "send";
  account: string;
  messageId: string;
  state: Action["state"];
  copy: "pending" | "saved" | "failed" | "not_attempted";
  acceptedCount?: number;
  rejectedCount?: number;
  created: string;
  updated: string;
}
type JournalAction = Action | SendAction;
export class Journal {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent TEXT, data TEXT NOT NULL);",
    );
  }
  get(id: string): JournalAction | undefined {
    const row = this.db.prepare("SELECT data FROM actions WHERE id=?").get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  begin(action: Action): { action: Action; fresh: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get(action.id);
      if (old) {
        if (
          old.kind === "send" ||
          JSON.stringify(old.source) !== JSON.stringify(action.source) ||
          old.target !== action.target ||
          old.kind !== action.kind ||
          old.parent !== action.parent ||
          old.reason !== action.reason
        )
          return fail(
            "ACTION_CONFLICT",
            "Aktions-ID wurde bereits für andere Parameter verwendet.",
          );
        this.db.exec("COMMIT");
        return { action: old, fresh: false };
      }
      const rows = this.db
        .prepare(
          "SELECT data FROM actions WHERE source=? OR (parent IS NOT NULL AND parent=?)",
        )
        .all(JSON.stringify(action.source), action.parent ?? null);
      if (rows.some((r) => JSON.parse(String(r.data)).state !== "failed"))
        fail(
          "ACTION_EXISTS",
          "Für diese Nachricht existiert bereits eine Aktion. Aktionsübersicht prüfen.",
        );
      this.db
        .prepare("INSERT INTO actions VALUES (?,?,?,?)")
        .run(
          action.id,
          JSON.stringify(action.source),
          action.parent ?? null,
          JSON.stringify(action),
        );
      this.db.exec("COMMIT");
      return { action, fresh: true };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  beginSend(action: SendAction): { action: SendAction; fresh: boolean } {
    const inserted = this.db
      .prepare(
        "INSERT INTO actions VALUES (?, ?, NULL, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(action.id, "", JSON.stringify(action));
    if (inserted.changes) return { action, fresh: true };
    const old = this.get(action.id);
    if (old?.kind !== "send" || old.account !== action.account)
      return fail("ACTION_CONFLICT", "Aktions-ID wurde bereits verwendet.");
    return { action: old, fresh: false };
  }
  save(action: JournalAction) {
    action.updated = new Date().toISOString();
    this.db
      .prepare("UPDATE actions SET data=? WHERE id=?")
      .run(JSON.stringify(action), action.id);
  }
  list(offset: number, limit: number) {
    const rows = this.db
      .prepare("SELECT data FROM actions ORDER BY rowid DESC LIMIT ? OFFSET ?")
      .all(limit + 1, offset);
    return {
      items: rows
        .slice(0, limit)
        .map((r) => JSON.parse(String(r.data)) as JournalAction),
      hasMore: rows.length > limit,
    };
  }
  close() {
    this.db.close();
  }
}
