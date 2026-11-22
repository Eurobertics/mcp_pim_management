import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Journal } from "./journal.js";
import { createServer } from "./server.js";
import { networkConfig, networkServer } from "./http.js";
process.umask(0o077);
try {
  const network = networkConfig();
  const config = loadConfig();
  process.env.TZ = config.displayTimezone;
  const journal = new Journal(config.statePath);
  const listener =
    network && networkServer(network, () => createServer(config, journal));
  const server = listener ? undefined : createServer(config, journal);
  if (listener && network) {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(network.port, network.host, resolve);
    });
  } else {
    await server?.connect(new StdioServerTransport());
  }
  const shutdown = async () => {
    if (listener)
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server?.close();
    journal.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  process.stderr.write(
    "PIM-Start fehlgeschlagen. PIM_CONFIG, Dateirechte und Transportkonfiguration prüfen.\n",
  );
  process.exitCode = 1;
}
