import { readFileSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import { z } from "zod";
import { fail } from "./common.js";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const credentials = {
  username: z.string().min(1),
  password: z.string().min(1),
};
const schema = z
  .object({
    statePath: z.string().refine(isAbsolute),
    displayTimezone: z
      .string()
      .default("Europe/Berlin")
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("de", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    mail: z
      .array(
        z.object({
          id,
          host: z.string().min(1),
          port: z.number().int().min(1).max(65535).default(993),
          ...credentials,
          quarantineFolder: z.string().min(1).default("PIM – Aussortiert"),
        }),
      )
      .max(20)
      .default([]),
    calendars: z
      .array(
        z.object({
          id,
          url: z
            .string()
            .url()
            .refine((v) => {
              const u = new URL(v);
              return (
                u.protocol === "https:" &&
                !u.username &&
                !u.password &&
                !u.search &&
                !u.hash
              );
            }),
          ...credentials,
        }),
      )
      .max(30)
      .default([]),
  })
  .strict();
export type Config = z.infer<typeof schema>;
export function loadConfig(path = process.env.PIM_CONFIG): Config {
  if (!path || !isAbsolute(path))
    return fail(
      "CONFIG",
      "PIM_CONFIG muss auf eine absolute Konfigurationsdatei zeigen.",
    );
  const repo = resolve(import.meta.dirname, "..");
  const rel = relative(repo, realpathSync(path));
  if (rel !== ".." && !rel.startsWith("../"))
    fail("CONFIG", "Zugangsdaten außerhalb des Repositorys ablegen.");
  if (statSync(path).mode & 0o077)
    fail(
      "CONFIG",
      "Konfigurationsdatei muss ausschließlich für den Benutzer lesbar sein (chmod 600).",
    );
  const result = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success)
    return fail(
      "CONFIG",
      "Ungültige Konfiguration; Beispiel und README prüfen.",
    );
  const c = result.data;
  for (const list of [c.mail, c.calendars])
    if (new Set(list.map((x) => x.id)).size !== list.length)
      fail("CONFIG", "Quellen-IDs müssen eindeutig sein.");
  return c;
}
