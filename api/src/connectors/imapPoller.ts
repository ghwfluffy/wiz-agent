import { createHash } from "node:crypto";
import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import sharp from "sharp";
import type { AgentModelClient } from "../agent/modelClient.js";
import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundAttachmentInput, InboundAttachmentMetadata, InboundMessageInput, RequestContext } from "../domain/types.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";
import { processInboundMessage } from "./inboundProcessor.js";
import { loadEmailSecret } from "./smtpSender.js";
import { classifySender, handleInboundMessage, type InboundRateLimiter } from "../security/senderPolicy.js";

type ImapConfig = {
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  mailbox: string;
  lastReceivedAt?: string;
  lastUid?: number;
};

type FetchMessage = {
  uid: number;
  envelope?: {
    messageId?: string;
  };
  source?: Buffer;
};

export type ImapErrorDetails = {
  name?: string;
  message: string;
  code?: string;
  response?: string;
  responseStatus?: string;
  command?: string;
};

export type ImapTestResult = {
  ok: boolean;
  configured: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  mailbox?: string;
  usernameSet?: boolean;
  passwordSet?: boolean;
  unseenCount?: number;
  error?: ImapErrorDetails;
};

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

function stringFromConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function numberFromConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function buildImapSearchCriteria(config: Pick<ImapConfig, "lastReceivedAt" | "lastUid">): SearchObject {
  if (typeof config.lastUid === "number" && Number.isFinite(config.lastUid) && config.lastUid > 0) {
    return { uid: `${Math.trunc(config.lastUid) + 1}:*` };
  }
  const lastReceivedAt = validDate(config.lastReceivedAt);
  if (lastReceivedAt) {
    return { since: lastReceivedAt };
  }
  return { seen: false };
}

export function isNewerThanLastReceived(receivedAt: string, lastReceivedAt: string | undefined): boolean {
  const last = validDate(lastReceivedAt);
  if (!last) {
    return true;
  }
  const received = validDate(receivedAt);
  return Boolean(received && received.getTime() > last.getTime());
}

export function imapErrorDetails(error: unknown): ImapErrorDetails {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const details = error as Error & {
    code?: string;
    response?: string;
    responseStatus?: string;
    command?: string;
  };
  return {
    name: details.name,
    message: details.message,
    code: details.code,
    response: details.response,
    responseStatus: details.responseStatus,
    command: details.command
  };
}

export async function resolveImapConfig(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
}): Promise<ImapConfig | undefined> {
  const connector = await options.store.getConnector(options.context, "imap");
  if (connector?.status !== "enabled") {
    return undefined;
  }
  const secret = loadEmailSecret(options.settings);
  const imapConfig = objectValue(connector.config.imap);
  return {
    username: stringConfig(connector.config.username, secret.username),
    password: stringConfig(imapConfig.password, secret.password),
    host: stringConfig(imapConfig.host, secret.imap?.host),
    port: numberConfig(imapConfig.port, secret.imap?.port),
    secure: booleanConfig(imapConfig.secure, secret.imap?.secure),
    mailbox: stringConfig(imapConfig.mailbox, secret.imap?.mailbox) ?? "INBOX",
    lastReceivedAt: stringFromConfig(imapConfig.last_received_at),
    lastUid: numberFromConfig(imapConfig.last_uid)
  };
}

async function updateImapProgress(options: {
  store: AgentStore;
  context: RequestContext;
  receivedAt?: string;
  uid?: number;
}): Promise<void> {
  const connector = await options.store.getConnector(options.context, "imap");
  if (!connector) {
    return;
  }
  const currentImap = objectValue(connector.config.imap);
  const currentReceivedAt = stringFromConfig(currentImap.last_received_at);
  const currentUid = numberFromConfig(currentImap.last_uid);
  const receivedAt = options.receivedAt && isNewerThanLastReceived(options.receivedAt, currentReceivedAt)
    ? options.receivedAt
    : currentReceivedAt;
  const uid = typeof options.uid === "number" && Number.isFinite(options.uid)
    ? Math.max(Math.trunc(options.uid), currentUid ?? 0)
    : currentUid;
  await options.store.upsertConnector(options.context, {
    kind: "imap",
    status: connector.status,
    config: {
      ...connector.config,
      imap: {
        ...currentImap,
        last_received_at: receivedAt ?? null,
        last_uid: uid ?? null
      }
    }
  });
}

async function seedImapProgressFromRecordedMessages(options: {
  store: AgentStore;
  context: RequestContext;
  config: ImapConfig;
}): Promise<ImapConfig> {
  if (options.config.lastReceivedAt || options.config.lastUid) {
    return options.config;
  }
  const latest = (await options.store.listInboundMessages(options.context))
    .map((message) => message.receivedAt ?? message.createdAt)
    .filter((value): value is string => Boolean(validDate(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (!latest) {
    return options.config;
  }
  await updateImapProgress({
    store: options.store,
    context: options.context,
    receivedAt: latest
  });
  return {
    ...options.config,
    lastReceivedAt: latest
  };
}

function firstAddress(value: Awaited<ReturnType<typeof simpleParser>>["from"]): string {
  return value?.value[0]?.address ?? "";
}

function addressText(value: Awaited<ReturnType<typeof simpleParser>>["to"]): string {
  if (!value) {
    return "";
  }
  return Array.isArray(value) ? value.flatMap((item) => item.value).map((item) => item.address).filter(Boolean).join(", ") : value.text;
}

function textBody(parsed: Awaited<ReturnType<typeof simpleParser>>): string {
  const text = parsed.text?.trim();
  if (text) {
    return text;
  }
  return parsed.html ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function sanitizeAttachmentFilename(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || null;
}

function hashAttachment(content: Buffer | undefined, fallback: string): string {
  return createHash("sha256").update(content ?? fallback).digest("hex");
}

export function metadataForParsedAttachments(
  parsed: Awaited<ReturnType<typeof simpleParser>>
): InboundAttachmentMetadata[] {
  return parsed.attachments.slice(0, 20).map((attachment) => {
    const contentType = (attachment.contentType || "application/octet-stream").trim().toLowerCase().slice(0, 160);
    const byteSize = Number.isFinite(attachment.size)
      ? Math.max(0, Math.trunc(attachment.size))
      : attachment.content.byteLength;
    return {
      filename: sanitizeAttachmentFilename(attachment.filename),
      contentType,
      byteSize,
      sha256: hashAttachment(attachment.content, `${attachment.filename ?? ""}:${contentType}:${byteSize}`),
      handling: "metadata_only",
      reason: contentType.startsWith("image/")
        ? "inbound_image_processing_not_enabled"
        : "inbound_attachment_storage_not_enabled"
    };
  });
}

export async function sanitizedOwnerAttachments(
  parsed: Awaited<ReturnType<typeof simpleParser>>
): Promise<InboundAttachmentInput[]> {
  const metadata = metadataForParsedAttachments(parsed);
  const output: InboundAttachmentInput[] = [];
  let acceptedImages = 0;
  let acceptedInputBytes = 0;
  for (const [index, attachment] of parsed.attachments.slice(0, 20).entries()) {
    const fallback = metadata[index];
    if (!fallback) continue;
    if (!["image/png", "image/jpeg", "image/webp"].includes(fallback.contentType)
      || fallback.byteSize <= 0
      || fallback.byteSize > 10 * 1024 * 1024
      || acceptedImages >= 5
      || acceptedInputBytes + fallback.byteSize > 25 * 1024 * 1024) {
      output.push(fallback);
      continue;
    }
    try {
      const content = await sharp(attachment.content, { failOn: "warning", limitInputPixels: 20_000_000 })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      if (content.length === 0 || content.length > 5 * 1024 * 1024) {
        output.push(fallback);
        continue;
      }
      acceptedImages += 1;
      acceptedInputBytes += fallback.byteSize;
      output.push({
        filename: fallback.filename,
        contentType: "image/png",
        byteSize: content.length,
        sha256: hashAttachment(content, "sanitized-owner-image"),
        handling: "sanitized_image",
        reason: "owner_image_sanitized_for_development",
        sanitizedDataBase64: content.toString("base64")
      });
    } catch {
      output.push(fallback);
    }
  }
  return output;
}

function sourceForAddress(address: string): string {
  const normalized = address.toLowerCase();
  if (normalized.includes("mms") || normalized.includes("mypixmessages")) {
    return "mms";
  }
  if (normalized.includes("sms") || normalized.includes("vtext") || normalized.includes("txt")) {
    return "sms";
  }
  return "imap";
}

export async function processImapInbox(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
  rateLimiter: InboundRateLimiter;
  modelClient?: AgentModelClient;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  limit?: number;
}): Promise<{ configured: boolean; attempted: number; recorded: number; failed: number }> {
  const resolvedConfig = await resolveImapConfig(options);
  if (!resolvedConfig) {
    return { configured: false, attempted: 0, recorded: 0, failed: 0 };
  }
  const config = await seedImapProgressFromRecordedMessages({
    store: options.store,
    context: options.context,
    config: resolvedConfig
  });
  if (!config.host || !config.username || !config.password) {
    return { configured: false, attempted: 0, recorded: 0, failed: 0 };
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user: config.username,
      pass: config.password
    },
    logger: false
  });
  client.on("error", () => undefined);
  let attempted = 0;
  let recorded = 0;
  let failed = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const unseen = await client.search(buildImapSearchCriteria(config), { uid: true });
      const unseenUids = Array.isArray(unseen) ? unseen.slice(0, options.limit ?? 10) : [];
      if (unseenUids.length === 0) {
        return { configured: true, attempted: 0, recorded: 0, failed: 0 };
      }
      for await (const rawMessage of client.fetch(unseenUids, { uid: true, envelope: true, source: true }, { uid: true })) {
        if (attempted >= (options.limit ?? 10)) {
          break;
        }
        attempted += 1;
        const message = rawMessage as FetchMessage;
        try {
          const parsed = await simpleParser(message.source ?? Buffer.from(""));
          const fromAddr = firstAddress(parsed.from);
          const classification = await classifySender({
            context: options.context,
            settings: options.settings,
            store: options.store,
            fromAddr
          });
          const inbound: InboundMessageInput = {
            providerMessageId: firstNonBlank(parsed.messageId, message.envelope?.messageId) ?? `${config.mailbox}:${message.uid}`,
            fromAddr,
            toAddr: addressText(parsed.to) || config.username,
            subject: parsed.subject ?? null,
            bodyText: textBody(parsed),
            receivedAt: parsed.date?.toISOString() ?? new Date().toISOString(),
            source: sourceForAddress(fromAddr),
            attachments: classification === "owner"
              ? await sanitizedOwnerAttachments(parsed)
              : metadataForParsedAttachments(parsed)
          };
          if (!isNewerThanLastReceived(inbound.receivedAt ?? "", config.lastReceivedAt)) {
            await updateImapProgress({
              store: options.store,
              context: options.context,
              uid: message.uid
            });
            await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
            continue;
          }
          if (options.modelClient) {
            await processInboundMessage({
              context: options.context,
              settings: options.settings,
              store: options.store,
              message: inbound,
              rateLimiter: options.rateLimiter,
              modelClient: options.modelClient,
              integrationTokenProvider: options.integrationTokenProvider,
              fetchImpl: options.fetchImpl
            });
          } else {
            await handleInboundMessage({
              context: options.context,
              settings: options.settings,
              store: options.store,
              message: inbound,
              rateLimiter: options.rateLimiter
            });
          }
          await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
          await updateImapProgress({
            store: options.store,
            context: options.context,
            receivedAt: inbound.receivedAt ?? undefined,
            uid: message.uid
          });
          config.lastReceivedAt = inbound.receivedAt ?? config.lastReceivedAt;
          config.lastUid = typeof config.lastUid === "number" ? Math.max(config.lastUid, message.uid) : message.uid;
          recorded += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { configured: true, attempted, recorded, failed };
}

export async function testImapConnection(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
}): Promise<ImapTestResult> {
  const config = await resolveImapConfig(options);
  if (!config) {
    return { ok: false, configured: false, error: { message: "IMAP connector is not enabled." } };
  }
  const base = {
    configured: Boolean(config.host && config.username && config.password),
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    mailbox: config.mailbox,
    usernameSet: Boolean(config.username),
    passwordSet: Boolean(config.password)
  };
  if (!base.configured || !config.host || !config.username || !config.password) {
    return { ok: false, ...base, error: { message: "IMAP configuration is incomplete." } };
  }
  const client = new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user: config.username,
      pass: config.password
    },
    logger: false
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      return {
        ok: true,
        ...base,
        unseenCount: Array.isArray(unseen) ? unseen.length : 0
      };
    } finally {
      lock.release();
    }
  } catch (error) {
    return {
      ok: false,
      ...base,
      error: imapErrorDetails(error)
    };
  } finally {
    await client.logout().catch(() => undefined);
  }
}
