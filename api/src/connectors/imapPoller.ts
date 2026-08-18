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
import { extractNewsletterPublicLinks } from "../security/newsletterPolicy.js";

export const DEFAULT_IMAP_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_IMAP_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
export const IMAP_UID_QUARANTINE_ATTEMPTS = 3;

export class ImapMessageSourceError extends Error {
  constructor(message: string, readonly sourceError?: unknown) {
    super(message);
    this.name = "ImapMessageSourceError";
  }
}

export function isDeterministicImapMessageFailure(error: unknown): error is ImapMessageSourceError {
  return error instanceof ImapMessageSourceError;
}

type ImapConfig = {
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  mailbox: string;
  lastReceivedAt?: string;
  lastUid?: number;
  uidValidity?: string;
  pollIntervalMs: number;
  nextPollAt?: string;
  consecutiveFailures: number;
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

function validUidCursor(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function uidValidityFromConfig(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function boundedPollIntervalMs(value: unknown): number {
  const seconds = numberFromConfig(value);
  if (seconds === undefined) {
    return DEFAULT_IMAP_POLL_INTERVAL_MS;
  }
  return Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.trunc(seconds * 1000)));
}

function validDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function buildImapSearchCriteria(config: Pick<ImapConfig, "lastReceivedAt" | "lastUid">): SearchObject {
  const lastUid = validUidCursor(config.lastUid);
  if (lastUid !== undefined) {
    return { uid: `${lastUid + 1}:*` };
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

export function isImapPollDue(nextPollAt: string | undefined, now = new Date()): boolean {
  const next = validDate(nextPollAt);
  return !next || next.getTime() <= now.getTime();
}

export function imapFailureBackoffMs(
  consecutiveFailures: number,
  pollIntervalMs = DEFAULT_IMAP_POLL_INTERVAL_MS
): number {
  const failures = Math.max(1, Math.trunc(consecutiveFailures));
  const exponent = Math.min(10, failures - 1);
  return Math.min(MAX_IMAP_FAILURE_BACKOFF_MS, Math.max(60_000, pollIntervalMs) * (2 ** exponent));
}

export function eligibleImapUids(uids: number[], lastUid: number | undefined, limit = 10): number[] {
  const cursor = typeof lastUid === "number" && Number.isFinite(lastUid) ? Math.trunc(lastUid) : 0;
  return [...new Set(uids.map((uid) => Math.trunc(uid)))]
    .filter((uid) => Number.isFinite(uid) && uid > cursor)
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, Math.trunc(limit)));
}

export function shouldResetImapUidCursor(storedUidValidity: string | undefined, mailboxUidValidity: string | undefined): boolean {
  return Boolean(storedUidValidity && mailboxUidValidity && storedUidValidity !== mailboxUidValidity);
}

export async function processImapUidBatch<T extends { uid: number }, R>(options: {
  messages: T[];
  processMessage: (message: T) => Promise<R>;
  commitMessage: (message: T, result: R) => Promise<void>;
  onFailure?: (message: T, error: unknown) => Promise<"continue" | "stop" | void>;
}): Promise<{ attempted: number; recorded: number; failed: number }> {
  let attempted = 0;
  let recorded = 0;
  let failed = 0;
  for (const message of [...options.messages].sort((left, right) => left.uid - right.uid)) {
    attempted += 1;
    try {
      const result = await options.processMessage(message);
      await options.commitMessage(message, result);
      recorded += 1;
    } catch (error) {
      failed += 1;
      const resolution = await options.onFailure?.(message, error);
      if (resolution === "continue") {
        continue;
      }
      break;
    }
  }
  return { attempted, recorded, failed };
}

async function clearImapUidFailureState(options: {
  store: AgentStore;
  context: RequestContext;
  uid: number;
  uidValidity?: string;
}): Promise<void> {
  const connector = await options.store.getConnector(options.context, "imap");
  if (!connector) {
    return;
  }
  const currentImap = objectValue(connector.config.imap);
  const failedUid = numberFromConfig(currentImap.failed_uid);
  const failedUidValidity = uidValidityFromConfig(currentImap.failed_uid_validity);
  if (failedUid !== options.uid || (options.uidValidity && failedUidValidity && failedUidValidity !== options.uidValidity)) {
    return;
  }
  await options.store.upsertConnector(options.context, {
    kind: "imap",
    status: connector.status,
    config: {
      ...connector.config,
      imap: {
        ...currentImap,
        failed_uid: null,
        failed_uid_attempts: 0,
        failed_uid_validity: null
      }
    }
  });
}

export async function resolveImapUidFailure(options: {
  store: AgentStore;
  context: RequestContext;
  uid: number;
  uidValidity?: string;
  error: unknown;
  quarantine: () => Promise<void>;
}): Promise<"continue" | "stop"> {
  const connector = await options.store.getConnector(options.context, "imap");
  if (!connector) {
    return "stop";
  }
  if (!isDeterministicImapMessageFailure(options.error)) {
    await options.store.recordAudit(options.context, "connector.imap_message_error", "connector", "imap", {
      uid: options.uid,
      uid_validity: options.uidValidity ?? null,
      retry_classification: "transient",
      error_name: options.error instanceof Error ? options.error.name.slice(0, 120) : "UnknownError",
      message: "Message handling failed outside deterministic source parsing. Processing stopped at this UID; the cursor and quarantine counter were not advanced."
    });
    return "stop";
  }
  const currentImap = objectValue(connector.config.imap);
  const failedUid = numberFromConfig(currentImap.failed_uid);
  const failedUidValidity = uidValidityFromConfig(currentImap.failed_uid_validity);
  const sameUid = failedUid === options.uid
    && (!options.uidValidity || !failedUidValidity || failedUidValidity === options.uidValidity);
  const priorAttempts = sameUid ? Math.max(0, Math.trunc(numberFromConfig(currentImap.failed_uid_attempts) ?? 0)) : 0;
  const attempts = Math.min(IMAP_UID_QUARANTINE_ATTEMPTS, priorAttempts + 1);
  await options.store.upsertConnector(options.context, {
    kind: "imap",
    status: connector.status,
    config: {
      ...connector.config,
      imap: {
        ...currentImap,
        failed_uid: options.uid,
        failed_uid_attempts: attempts,
        failed_uid_validity: options.uidValidity ?? null
      }
    }
  });
  await options.store.recordAudit(options.context, "connector.imap_message_error", "connector", "imap", {
    uid: options.uid,
    uid_validity: options.uidValidity ?? null,
    retry_classification: "deterministic_source",
    attempt: attempts,
    quarantine_threshold: IMAP_UID_QUARANTINE_ATTEMPTS,
    error_name: options.error instanceof Error ? options.error.name.slice(0, 120) : "UnknownError",
    message: attempts < IMAP_UID_QUARANTINE_ATTEMPTS
      ? "Message ingestion failed. Processing stopped at this UID; the cursor was not advanced past it."
      : "Message ingestion failed at the retry threshold and is being quarantined."
  });
  if (attempts < IMAP_UID_QUARANTINE_ATTEMPTS) {
    return "stop";
  }
  await options.store.recordAudit(options.context, "connector.imap_message_quarantined", "connector", "imap", {
    uid: options.uid,
    uid_validity: options.uidValidity ?? null,
    attempts,
    message: "The malformed message reached the bounded retry threshold. Its UID will be advanced explicitly so later mail can proceed."
  });
  await options.quarantine();
  await clearImapUidFailureState(options);
  return "continue";
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
    lastUid: numberFromConfig(imapConfig.last_uid),
    uidValidity: uidValidityFromConfig(imapConfig.uid_validity),
    pollIntervalMs: boundedPollIntervalMs(imapConfig.poll_interval_seconds),
    nextPollAt: stringFromConfig(imapConfig.next_poll_at),
    consecutiveFailures: Math.max(0, Math.trunc(numberFromConfig(imapConfig.consecutive_failures) ?? 0))
  };
}

async function synchronizeImapUidValidity(options: {
  store: AgentStore;
  context: RequestContext;
  config: ImapConfig;
  mailboxUidValidity?: string;
}): Promise<void> {
  if (!options.mailboxUidValidity) {
    return;
  }
  const resetCursor = shouldResetImapUidCursor(options.config.uidValidity, options.mailboxUidValidity);
  if (!resetCursor && options.config.uidValidity === options.mailboxUidValidity) {
    return;
  }
  const connector = await options.store.getConnector(options.context, "imap");
  if (!connector) {
    return;
  }
  const currentImap = objectValue(connector.config.imap);
  await options.store.upsertConnector(options.context, {
    kind: "imap",
    status: connector.status,
    config: {
      ...connector.config,
      imap: {
        ...currentImap,
        uid_validity: options.mailboxUidValidity,
        ...(resetCursor ? {
          last_uid: null,
          last_received_at: null,
          failed_uid: null,
          failed_uid_attempts: 0,
          failed_uid_validity: null
        } : {})
      }
    }
  });
  if (resetCursor) {
    await options.store.recordAudit(options.context, "connector.imap_uidvalidity_reset", "connector", "imap", {
      previous_uid_validity: options.config.uidValidity,
      mailbox_uid_validity: options.mailboxUidValidity,
      message: "The mailbox UID validity changed, so the stale UID cursor was cleared before searching."
    });
    options.config.lastUid = undefined;
    options.config.lastReceivedAt = undefined;
  }
  options.config.uidValidity = options.mailboxUidValidity;
}

async function updateImapPollState(options: {
  store: AgentStore;
  context: RequestContext;
  config: Pick<ImapConfig, "pollIntervalMs" | "consecutiveFailures">;
  succeeded: boolean;
  now?: Date;
}): Promise<void> {
  const connector = await options.store.getConnector(options.context, "imap");
  if (!connector) {
    return;
  }
  const now = options.now ?? new Date();
  const currentImap = objectValue(connector.config.imap);
  const currentFailures = Math.max(0, Math.trunc(numberFromConfig(currentImap.consecutive_failures) ?? options.config.consecutiveFailures));
  const consecutiveFailures = options.succeeded ? 0 : currentFailures + 1;
  const delayMs = options.succeeded
    ? options.config.pollIntervalMs
    : imapFailureBackoffMs(consecutiveFailures, options.config.pollIntervalMs);
  await options.store.upsertConnector(options.context, {
    kind: "imap",
    status: connector.status,
    config: {
      ...connector.config,
      imap: {
        ...currentImap,
        poll_interval_seconds: Math.trunc(options.config.pollIntervalMs / 1000),
        next_poll_at: new Date(now.getTime() + delayMs).toISOString(),
        consecutive_failures: consecutiveFailures,
        last_poll_attempt_at: now.toISOString(),
        ...(options.succeeded
          ? { last_poll_succeeded_at: now.toISOString() }
          : { last_poll_failed_at: now.toISOString() })
      }
    }
  });
}

async function updateImapProgress(options: {
  store: AgentStore;
  context: RequestContext;
  receivedAt?: string;
  uid?: number;
  clearFailureUid?: number;
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
  const failedUid = numberFromConfig(currentImap.failed_uid);
  const clearFailure = typeof options.clearFailureUid === "number" && failedUid === Math.trunc(options.clearFailureUid);
  await options.store.upsertConnector(options.context, {
    kind: "imap",
    status: connector.status,
    config: {
      ...connector.config,
      imap: {
        ...currentImap,
        last_received_at: receivedAt ?? null,
        last_uid: uid ?? null,
        ...(clearFailure ? {
          failed_uid: null,
          failed_uid_attempts: 0,
          failed_uid_validity: null
        } : {})
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

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)));
}

function htmlAnchorHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(pattern)) {
    const href = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (href) {
      hrefs.push(href);
    }
  }
  return hrefs;
}

export function normalizedMessageBody(parsed: Awaited<ReturnType<typeof simpleParser>>): string {
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = parsed.text?.trim() || html
    .replace(/<\/?(?:p|div|li|h[1-6]|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const missingLinks = extractNewsletterPublicLinks(htmlAnchorHrefs(html).join("\n"))
    .filter((link) => !text.includes(link));
  return [
    text,
    missingLinks.length > 0 ? `Source links:\n${missingLinks.join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
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
  if (!resolvedConfig.host || !resolvedConfig.username || !resolvedConfig.password) {
    return { configured: false, attempted: 0, recorded: 0, failed: 0 };
  }
  const host = resolvedConfig.host;
  const username = resolvedConfig.username;
  const password = resolvedConfig.password;
  if (!isImapPollDue(resolvedConfig.nextPollAt)) {
    return { configured: true, attempted: 0, recorded: 0, failed: 0 };
  }
  const config = await seedImapProgressFromRecordedMessages({
    store: options.store,
    context: options.context,
    config: resolvedConfig
  });

  const client = new ImapFlow({
    host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user: username,
      pass: password
    },
    logger: false
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    let result = { attempted: 0, recorded: 0, failed: 0 };
    try {
      await synchronizeImapUidValidity({
        store: options.store,
        context: options.context,
        config,
        mailboxUidValidity: client.mailbox ? client.mailbox.uidValidity.toString() : undefined
      });
      const found = await client.search(buildImapSearchCriteria(config), { uid: true });
      const candidateUids = eligibleImapUids(Array.isArray(found) ? found : [], config.lastUid, options.limit ?? 10);
      const messages: FetchMessage[] = [];
      if (candidateUids.length > 0) {
        for await (const rawMessage of client.fetch(candidateUids, { uid: true, envelope: true, source: true }, { uid: true })) {
          const message = rawMessage as FetchMessage;
          if (candidateUids.includes(message.uid)) {
            messages.push(message);
          }
        }
      }
      result = await processImapUidBatch({
        messages,
        processMessage: async (message) => {
          if (!message.source) {
            throw new ImapMessageSourceError("IMAP message source was unavailable.");
          }
          let parsed: Awaited<ReturnType<typeof simpleParser>>;
          let fromAddr: string;
          let toAddr: string;
          let subject: string | null;
          let bodyText: string;
          let receivedAt: string;
          let source: string;
          let providerMessageId: string;
          let attachmentMetadata: InboundAttachmentMetadata[];
          try {
            parsed = await simpleParser(message.source);
            fromAddr = firstAddress(parsed.from);
            toAddr = addressText(parsed.to) || username;
            subject = parsed.subject ?? null;
            bodyText = normalizedMessageBody(parsed);
            receivedAt = parsed.date?.toISOString() ?? new Date().toISOString();
            source = sourceForAddress(fromAddr);
            providerMessageId = firstNonBlank(parsed.messageId, message.envelope?.messageId) ?? `${config.mailbox}:${message.uid}`;
            attachmentMetadata = metadataForParsedAttachments(parsed);
          } catch (error) {
            throw new ImapMessageSourceError("IMAP message source could not be parsed or normalized.", error);
          }
          const classification = await classifySender({
            context: options.context,
            settings: options.settings,
            store: options.store,
            fromAddr
          });
          const inbound: InboundMessageInput = {
            providerMessageId,
            fromAddr,
            toAddr,
            subject,
            bodyText,
            receivedAt,
            source,
            attachments: classification === "owner"
              ? await sanitizedOwnerAttachments(parsed)
              : attachmentMetadata
          };
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
          return { receivedAt: inbound.receivedAt ?? undefined };
        },
        commitMessage: async (message, processed) => {
          await updateImapProgress({
            store: options.store,
            context: options.context,
            receivedAt: processed.receivedAt,
            uid: message.uid,
            clearFailureUid: message.uid
          });
          config.lastReceivedAt = processed.receivedAt && isNewerThanLastReceived(processed.receivedAt, config.lastReceivedAt)
            ? processed.receivedAt
            : config.lastReceivedAt;
          config.lastUid = typeof config.lastUid === "number" ? Math.max(config.lastUid, message.uid) : message.uid;
          await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true }).catch(async () => {
            await options.store.recordAudit(options.context, "connector.imap_seen_error", "connector", "imap", {
              uid: message.uid,
              message: "The message was ingested and the UID cursor advanced, but the provider did not accept the Seen flag."
            }).catch(() => undefined);
          });
        },
        onFailure: async (message, error) => {
          return resolveImapUidFailure({
            store: options.store,
            context: options.context,
            uid: message.uid,
            uidValidity: config.uidValidity,
            error,
            quarantine: async () => {
              await updateImapProgress({
                store: options.store,
                context: options.context,
                uid: message.uid,
                clearFailureUid: message.uid
              });
              config.lastUid = typeof config.lastUid === "number" ? Math.max(config.lastUid, message.uid) : message.uid;
              await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true }).catch(async () => {
                await options.store.recordAudit(options.context, "connector.imap_seen_error", "connector", "imap", {
                  uid: message.uid,
                  message: "The quarantined UID cursor advanced, but the provider did not accept the Seen flag."
                }).catch(() => undefined);
              });
            }
          });
        }
      });
    } finally {
      lock.release();
    }
    await updateImapPollState({
      store: options.store,
      context: options.context,
      config,
      succeeded: result.failed === 0
    });
    return { configured: true, ...result };
  } catch (error) {
    await updateImapPollState({
      store: options.store,
      context: options.context,
      config,
      succeeded: false
    }).catch(() => undefined);
    throw error;
  } finally {
    await client.logout().catch(() => undefined);
  }
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
