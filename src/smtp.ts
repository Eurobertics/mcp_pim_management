import { createRequire } from "node:module";
import type { Config } from "./config.js";

type SmtpConfig = NonNullable<Config["mail"][number]["smtp"]>;
export type OutgoingMail = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
};

// Only the two Nodemailer transport interfaces used here.
const { createTransport } = createRequire(import.meta.url)("nodemailer") as {
  createTransport(options: {
    streamTransport: true;
    buffer: true;
    newline: "windows";
  }): {
    sendMail(
      mail: OutgoingMail & { from: string; references?: string },
    ): Promise<{ message: Buffer }>;
  };
  createTransport(options: {
    host: string;
    port: number;
    secure: boolean;
    requireTLS: boolean;
    tls: { rejectUnauthorized: true };
    auth: { user: string; pass: string };
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
  }): {
    sendMail(mail: {
      raw: Buffer;
      envelope: { from: string; to: string[] };
    }): Promise<{
      accepted: string[];
      rejected: string[];
    }>;
  };
};

export async function composeMail(from: string, mail: OutgoingMail) {
  // Bcc recipients belong exclusively to the SMTP envelope.
  const { bcc, ...headers } = mail;
  const composer = createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
  });
  return (
    await composer.sendMail({ ...headers, from, references: mail.inReplyTo })
  ).message;
}

export function submitMail(
  config: SmtpConfig,
  raw: Buffer,
  mail: OutgoingMail,
) {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.tls === "implicit",
    requireTLS: config.tls === "starttls",
    tls: { rejectUnauthorized: true },
    auth: { user: config.username, pass: config.password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return transport.sendMail({
    raw,
    envelope: {
      from: config.from,
      to: [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])],
    },
  });
}
