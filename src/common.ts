import { z } from "zod";
export class PimError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string): never => {
  throw new PimError(code, message);
};
export const refSchema = z.object({
  account: z.string().min(1).max(100),
  folder: z.string().min(1).max(500),
  uidValidity: z.string().regex(/^\d+$/),
  uid: z.number().int().positive(),
});
export type MailRef = z.infer<typeof refSchema>;
export const rangeSchema = {
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
};
export function range(from: string, to: string) {
  const a = new Date(from),
    b = new Date(to);
  if (
    !Number.isFinite(+a) ||
    !Number.isFinite(+b) ||
    +b <= +a ||
    +b - +a > 93 * 86400000
  )
    fail(
      "INVALID_RANGE",
      "Zeitraum muss positiv und höchstens 93 Tage lang sein.",
    );
  return { from: a, to: b };
}
export const pageSchema = {
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(4000).optional(),
};
export function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decode<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString());
  } catch {
    return fail("INVALID_CURSOR", "Ungültiger Cursor.");
  }
}
export function safeError(error: unknown) {
  return error instanceof PimError
    ? { code: error.code, message: error.message }
    : {
        code: "SOURCE_ERROR",
        message:
          "Abruf oder Aktion fehlgeschlagen. Verbindung, Zugang und Serverkonfiguration prüfen.",
      };
}
