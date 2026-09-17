import { test } from "node:test";
import assert from "node:assert/strict";
import fetchCommand from "imapflow/lib/commands/fetch.js";
import moveCommand from "imapflow/lib/commands/move.js";
test("installed IMAP library emits UID FETCH BODY.PEEK and atomic UID MOVE", async () => {
  const commands = [];
  const connection = {
    state: 3,
    states: { SELECTED: 3 },
    mailbox: { path: "INBOX" },
    capabilities: new Map([
      ["MOVE", true],
      ["UIDPLUS", true],
    ]),
    enabled: new Set(),
    namespace: { prefix: "", delimiter: "/" },
    log: { warn() {} },
    exec: async (command, attrs) => {
      commands.push({ command, attrs });
      return { next() {}, response: { attributes: [] } };
    },
  };
  await fetchCommand(
    connection,
    "42",
    { source: true, flags: true },
    { uid: true },
  );
  assert.equal(commands[0].command, "UID FETCH");
  const body = commands[0].attrs[1].find((x) => x.value === "BODY.PEEK");
  assert(body);
  assert.deepEqual(body.section, []);
  await moveCommand(connection, "42", "PIM – Aussortiert", { uid: true });
  assert.equal(commands[1].command, "UID MOVE");
  assert.deepEqual(
    commands.map((x) => x.command),
    ["UID FETCH", "UID MOVE"],
  );
});
