import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Journal } from "./journal.js";
import { createServer } from "./server.js";
process.umask(0o077);
try {
  const config = loadConfig();
  process.env.TZ = config.displayTimezone;
  const journal = new Journal(config.statePath);
  const server = createServer(config, journal);
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await server.close();
    journal.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  process.stderr.write(
    "PIM-Start fehlgeschlagen. PIM_CONFIG, Dateirechte und Konfiguration prüfen.\n",
  );
  process.exitCode = 1;
}
