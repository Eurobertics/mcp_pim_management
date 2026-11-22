import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:https";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../dist/server.js";
import { networkConfig, networkServer } from "../dist/http.js";

const token = "test-token";
const config = { mail: [], calendars: [], displayTimezone: "Europe/Berlin" };
const headers = { Authorization: "Bearer " + token };
async function listen(t, options) {
  const server = networkServer(options, () => createServer(config, {}));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("Streamable HTTP discovers tools and enforces authentication and routing", async (t) => {
  assert.equal(networkConfig({}), undefined);
  assert.throws(() => networkConfig({ PIM_TRANSPORT: "http" }), /PIM_TOKEN/);
  assert.throws(() =>
    networkConfig({ PIM_TRANSPORT: "https", PIM_TOKEN: token }),
  );
  const options = networkConfig({ PIM_TRANSPORT: "http", PIM_TOKEN: token });
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 3000);
  const port = await listen(t, options);
  const url = new URL("http://127.0.0.1:" + port + "/mcp");
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status,
    401,
  );
  assert.equal(
    (
      await fetch(url, {
        headers: { ...headers, Origin: "https://example.test" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(new URL("/other", url), { headers })).status, 404);
  const client = new Client({ name: "tests", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    );
    assert(
      (await client.listTools()).tools.some(
        ({ name }) => name === "calendar_create",
      ),
    );
    const status = await client.callTool({ name: "pim_status", arguments: {} });
    assert.equal(status.structuredContent.data.connectivity, "not_checked");
  } finally {
    await client.close();
  }
});

test("HTTPS works with a self-signed certificate trusted by the client", async (t) => {
  if (spawnSync("openssl", ["version"]).error)
    return t.skip("OpenSSL unavailable");
  const dir = mkdtempSync(join(tmpdir(), "pim-tls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const generated = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-out",
    cert,
    "-keyout",
    key,
  ]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const port = await listen(
    t,
    networkConfig({
      PIM_TRANSPORT: "https",
      PIM_TOKEN: token,
      PIM_TLS_CERT: cert,
      PIM_TLS_KEY: key,
    }),
  );
  const response = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        ca: readFileSync(cert),
        headers: {
          ...headers,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
  assert.equal(response.status, 200);
  assert.equal(
    JSON.parse(response.body).result.serverInfo.name,
    "pim-management",
  );
});
