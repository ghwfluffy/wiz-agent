import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { AgentModelClient } from "../agent/modelClient.js";
import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageInput, RequestContext } from "../domain/types.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";
import { processInboundMessage } from "./inboundProcessor.js";
import { loadEmailSecret } from "./smtpSender.js";
import { handleInboundMessage, type InboundRateLimiter } from "../security/senderPolicy.js";

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
          const inbound: InboundMessageInput = {
            providerMessageId: parsed.messageId ?? message.envelope?.messageId ?? `${config.mailbox}:${message.uid}`,
            fromAddr,
            toAddr: addressText(parsed.to) || config.username,
            subject: parsed.subject ?? null,
            bodyText: textBody(parsed),
            receivedAt: parsed.date?.toISOString() ?? new Date().toISOString(),
            source: sourceForAddress(fromAddr)
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
