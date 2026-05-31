import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import type { Settings } from "../config/settings.js";
import type { AgentStore, OutboundMessageRecord, RequestContext } from "../domain/types.js";

type EmailSecret = {
  username?: string;
  password?: string;
  smtp?: {
    host?: string;
    port?: number;
    secure?: boolean;
    from?: string;
  };
};

export type MailTransport = {
  sendMail(message: {
    from: string;
    to: string;
    subject?: string;
    text: string;
  }): Promise<unknown>;
};

export function loadEmailSecret(settings: Settings): EmailSecret {
  return JSON.parse(readFileSync(resolve(settings.agentSecretDir, "email.json"), "utf8")) as EmailSecret;
}

export function resolveSmtpSecure(secret: EmailSecret): boolean {
  return secret.smtp?.secure ?? secret.smtp?.port === 465;
}

export function createSmtpTransport(settings: Settings): MailTransport {
  const secret = loadEmailSecret(settings);
  if (!secret.smtp?.host || !secret.username || !secret.password) {
    throw new Error("SMTP secret is incomplete.");
  }
  return nodemailer.createTransport({
    host: secret.smtp.host,
    port: secret.smtp.port ?? 587,
    secure: resolveSmtpSecure(secret),
    auth: {
      user: secret.username,
      pass: secret.password
    }
  });
}

export async function sendOutboundMessage(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
  message: OutboundMessageRecord;
  transport?: MailTransport;
}): Promise<OutboundMessageRecord | undefined> {
  if (!options.settings.agentOutboundEnabled) {
    return options.store.updateOutboundMessageStatus(
      options.context,
      options.message.id,
      "failed",
      "Outbound delivery is disabled."
    );
  }
  if (!["pending", "approved"].includes(options.message.status)) {
    return options.message;
  }
  const secret = loadEmailSecret(options.settings);
  const from = secret.smtp?.from ?? secret.username;
  if (!from) {
    return options.store.updateOutboundMessageStatus(options.context, options.message.id, "failed", "SMTP sender is missing.");
  }
  const transport = options.transport ?? createSmtpTransport(options.settings);
  await options.store.updateOutboundMessageStatus(options.context, options.message.id, "sending");
  try {
    await transport.sendMail({
      from,
      to: options.message.toAddr,
      subject: options.message.subject ?? undefined,
      text: options.message.bodyText
    });
    return options.store.updateOutboundMessageStatus(options.context, options.message.id, "sent");
  } catch (error) {
    return options.store.updateOutboundMessageStatus(
      options.context,
      options.message.id,
      "failed",
      error instanceof Error ? error.message : "SMTP send failed."
    );
  }
}

export async function processOutboundQueue(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
  limit?: number;
  transport?: MailTransport;
}): Promise<{ attempted: number; sent: number; failed: number }> {
  const messages = (await options.store.listOutboundMessages(options.context, ["pending", "approved"]))
    .slice(0, options.limit ?? 10);
  let sent = 0;
  let failed = 0;
  for (const message of messages) {
    const updated = await sendOutboundMessage({
      store: options.store,
      context: options.context,
      settings: options.settings,
      message,
      transport: options.transport
    });
    if (updated?.status === "sent") {
      sent += 1;
    } else if (updated?.status === "failed") {
      failed += 1;
    }
  }
  return { attempted: messages.length, sent, failed };
}
