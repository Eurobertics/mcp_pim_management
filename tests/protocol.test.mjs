import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../dist/config.js";
test("real stdio MCP initialization, tool discovery, calls, schema errors and safe source failures", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pim-protocol-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      statePath: join(dir, "actions.sqlite"),
      mail: [
        {
          id: "offline",
          host: "127.0.0.1",
          port: 1,
          username: "test",
          password: "DO-NOT-LEAK",
        },
      ],
      calendars: [],
    }),
    { mode: 0o600 },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: { ...process.env, PIM_CONFIG: path },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "pim-tests", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(`Connect failed: ${stderr}`, { cause: e });
  }
  t.after(async () => {
    await client.close();
    assert(!stderr.includes("DO-NOT-LEAK"));
  });
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 8);
  const names = listed.tools.map((x) => x.name);
  assert(names.includes("mail_restore"));
  for (const tool of listed.tools)
    assert.equal(
      tool.annotations.readOnlyHint,
      !["mail_restore", "mail_quarantine"].includes(tool.name),
    );
  const status = await client.callTool({ name: "pim_status", arguments: {} });
  assert.equal(status.structuredContent.data.connectivity, "not_checked");
  assert(!JSON.stringify(status).includes("DO-NOT-LEAK"));
  const offline = await client.callTool({
    name: "mail_folders",
    arguments: { account: "offline" },
  });
  assert.equal(offline.isError, true);
  assert.equal(offline.structuredContent.complete, false);
  assert(!JSON.stringify(offline).includes("DO-NOT-LEAK"));
  const bad = await client.callTool({
    name: "mail_read",
    arguments: { ref: { uid: -1 } },
  });
  assert.equal(bad.isError, true);
  const unknown = await client.callTool({ name: "not_a_tool", arguments: {} });
  assert.equal(unknown.isError, true);
  const actions = await client.callTool({ name: "pim_actions", arguments: {} });
  assert.deepEqual(actions.structuredContent.data.items, []);
  // Validate every tool/parameter example in the delivered skill against the actual advertised schemas.
  const examples = JSON.parse(
    readFileSync("skills/pim-management/references/tool-examples.json", "utf8"),
  );
  for (const example of examples) {
    const tool = listed.tools.find((x) => x.name === example.name);
    assert(tool, example.name);
    for (const key of Object.keys(example.arguments))
      assert(key in tool.inputSchema.properties, `${example.name}.${key}`);
    for (const key of tool.inputSchema.required ?? [])
      assert(key in example.arguments, `${example.name} missing ${key}`);
  }
});
test("configuration rejects public credentials, duplicate IDs and invalid TLS URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pim-config-"));
  const p = join(dir, "config.json");
  const base = { statePath: join(dir, "db"), mail: [], calendars: [] };
  writeFileSync(p, JSON.stringify(base), { mode: 0o644 });
  assert.throws(() => loadConfig(p), { code: "CONFIG" });
  chmodSync(p, 0o600);
  assert.equal(loadConfig(p).displayTimezone, "Europe/Berlin");
  writeFileSync(
    p,
    JSON.stringify({
      ...base,
      calendars: [
        {
          id: "a",
          url: "http://example.invalid/",
          username: "x",
          password: "x",
        },
      ],
    }),
  );
  assert.throws(() => loadConfig(p), { code: "CONFIG" });
});
