import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import type { Settings } from "../config/settings.js";
import type { AgentStore, OutboundMessageRecord, RequestContext } from "../domain/types.js";

type EmailSecret = {
  username?: string;
  password?: string;
  imap?: {
    host?: string;
    port?: number;
    secure?: boolean;
    mailbox?: string;
  };
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
  const path = resolve(settings.agentSecretDir, "email.json");
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8")) as EmailSecret;
}

export function resolveSmtpSecure(secret: EmailSecret): boolean {
  return secret.smtp?.secure ?? secret.smtp?.port === 465;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringConfig(primary: unknown, fallback: unknown): string | undefined {
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function numberConfig(primary: unknown, fallback: unknown): number | undefined {
  if (typeof primary === "number" && Number.isFinite(primary)) {
    return primary;
  }
  if (typeof fallback === "number" && Number.isFinite(fallback)) {
    return fallback;
  }
  return undefined;
}

function booleanConfig(primary: unknown, fallback: unknown): boolean | undefined {
  if (typeof primary === "boolean") {
    return primary;
  }
  if (typeof fallback === "boolean") {
    return fallback;
  }
  return undefined;
}

export type SmtpDeliveryConfig = {
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  from?: string;
};

export async function resolveSmtpDeliveryConfig(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
}): Promise<SmtpDeliveryConfig> {
  const secret = loadEmailSecret(options.settings);
  const connector = await options.store.getConnector(options.context, "smtp");
  const config = connector?.status === "enabled" ? connector.config : {};
  const smtpConfig = objectValue(config.smtp);
  return {
    username: stringConfig(config.username, secret.username),
    password: stringConfig(smtpConfig.password, secret.password),
    host: stringConfig(smtpConfig.host, secret.smtp?.host),
    port: numberConfig(smtpConfig.port, secret.smtp?.port),
    secure: booleanConfig(smtpConfig.secure, secret.smtp?.secure),
    from: stringConfig(smtpConfig.from, secret.smtp?.from)
  };
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
  const delivery = await resolveSmtpDeliveryConfig(options);
  const from = delivery.from ?? delivery.username;
  if (!from) {
    return options.store.updateOutboundMessageStatus(options.context, options.message.id, "failed", "SMTP sender is missing.");
  }
  if (!delivery.host || !delivery.username || !delivery.password) {
    return options.store.updateOutboundMessageStatus(options.context, options.message.id, "failed", "SMTP configuration is incomplete.");
  }
  const transport = options.transport ?? nodemailer.createTransport({
    host: delivery.host,
    port: delivery.port ?? 587,
    secure: delivery.secure ?? delivery.port === 465,
    auth: {
      user: delivery.username,
      pass: delivery.password
    }
  });
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
    .slice(0, options.limit ?? 1);
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
