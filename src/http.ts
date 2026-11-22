import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function networkConfig(env = process.env) {
  const mode = env.PIM_TRANSPORT ?? "stdio";
  if (mode === "stdio") return;
  if (mode !== "http" && mode !== "https") throw new Error("PIM_TRANSPORT");
  const host = env.PIM_HOST ?? "127.0.0.1";
  const rawPort = env.PIM_PORT ?? "3000";
  const port = Number(rawPort);
  const token = env.PIM_TOKEN ?? "";
  if (!host.trim() || !/^\d+$/.test(rawPort) || port < 1 || port > 65535)
    throw new Error("PIM_HOST / PIM_PORT");
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error("PIM_TOKEN");
  const tls =
    mode === "https"
      ? {
          cert: readFileSync(env.PIM_TLS_CERT ?? ""),
          key: readFileSync(env.PIM_TLS_KEY ?? ""),
          minVersion: "TLSv1.2" as const,
        }
      : undefined;
  return { host, port, token, tls };
}

export function networkServer(
  config: NonNullable<ReturnType<typeof networkConfig>>,
  makeServer: () => McpServer,
) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${config.token}`);
  const listener: RequestListener = (req, res) => {
    if (req.url?.split("?")[0] !== "/mcp") return void res.writeHead(404).end();
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? "")))
      return void res
        .writeHead(401, { "WWW-Authenticate": 'Bearer realm="pim-management"' })
        .end();
    if (req.headers.origin !== undefined) return void res.writeHead(403).end();
    if (req.method !== "POST")
      return void res.writeHead(405, { Allow: "POST" }).end();
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => void server.close().catch(() => {}));
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  };
  return config.tls
    ? createHttpsServer(config.tls, listener)
    : createServer(listener);
}
