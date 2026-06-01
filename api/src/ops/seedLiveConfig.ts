import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createPool } from "../db/pool.js";
import { loadSettings } from "../config/settings.js";

type ContactSecret = {
  name?: string;
  email?: string;
  mobile?: string;
  mobileProvider?: string;
  smsGateway?: string;
  mmsGateway?: string;
};

type EmailSecret = {
  username?: string;
  password?: string;
  imap?: Record<string, unknown>;
  smtp?: Record<string, unknown>;
};

type SeedSummary = {
  dryRun: boolean;
  userSelector: string;
  contact: {
    hasEmail: boolean;
    hasSmsGateway: boolean;
    hasMmsGateway: boolean;
  };
  email: {
    hasUsername: boolean;
    hasPassword: boolean;
    hasImap: boolean;
    hasSmtp: boolean;
  };
  openai: {
    hasApiKeyFile: boolean;
  };
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function bool(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function secretDir(): string {
  const index = process.argv.indexOf("--secret-dir");
  const requested = process.argv[index + 1];
  if (index >= 0 && requested) {
    return resolve(requested);
  }
  return resolve(process.env.AGENT_SECRET_DIR ?? "secrets");
}

function dryRun(): boolean {
  return process.argv.includes("--dry-run") || process.env.AGENT_SEED_DRY_RUN === "true";
}

function selector(): { kind: "email" | "id"; value: string } {
  const userId = process.env.AGENT_SEED_USER_ID;
  if (userId) {
    return { kind: "id", value: userId };
  }
  const email = process.env.AGENT_SEED_USER_EMAIL;
  if (email) {
    return { kind: "email", value: email.toLowerCase() };
  }
  throw new Error("Set AGENT_SEED_USER_ID or AGENT_SEED_USER_EMAIL before seeding live config.");
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const dir = secretDir();
  const contact = readJson<ContactSecret>(resolve(dir, "contact.json"));
  const email = readJson<EmailSecret>(resolve(dir, "email.json"));
  const openaiKey = readFileSync(resolve(dir, "openai.txt"), "utf8").trim();
  const userSelector = selector();
  const summary: SeedSummary = {
    dryRun: dryRun(),
    userSelector: `${userSelector.kind}:${userSelector.value}`,
    contact: {
      hasEmail: bool(contact.email),
      hasSmsGateway: bool(contact.smsGateway),
      hasMmsGateway: bool(contact.mmsGateway)
    },
    email: {
      hasUsername: bool(email.username),
      hasPassword: bool(email.password),
      hasImap: bool(email.imap),
      hasSmtp: bool(email.smtp)
    },
    openai: {
      hasApiKeyFile: bool(openaiKey)
    }
  };

  if (summary.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const pool = createPool(settings);
  try {
    const userResult = await pool.query(
      userSelector.kind === "id"
        ? "SELECT id FROM users WHERE id = $1"
        : "SELECT id FROM users WHERE lower(email) = lower($1)",
      [userSelector.value]
    );
    const userId = userResult.rows[0]?.id as string | undefined;
    if (!userId) {
      throw new Error(`No agent user matched ${summary.userSelector}. Sign in with OAuth first or provide AGENT_SEED_USER_ID.`);
    }

    await pool.query(
      `INSERT INTO connectors (id, user_id, kind, status, config_json)
       VALUES
         ($1, $2, 'owner-contact', 'enabled', $3),
         ($4, $2, 'imap', 'enabled', $5),
         ($6, $2, 'smtp', 'enabled', $7),
         ($8, $2, 'openai', 'enabled', $9)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        userId,
        { name: contact.name ?? null, provider: contact.mobileProvider ?? null, has_sms: summary.contact.hasSmsGateway, has_mms: summary.contact.hasMmsGateway },
        randomUUID(),
        { username: email.username ?? null, imap: email.imap ?? {}, secret_ref: "email.json" },
        randomUUID(),
        { username: email.username ?? null, smtp: email.smtp ?? {}, secret_ref: "email.json" },
        randomUUID(),
        { base_url: settings.agentOpenaiBaseUrl, secret_ref: "openai.txt" }
      ]
    );

    for (const address of [contact.email, contact.smsGateway, contact.mmsGateway].filter(Boolean)) {
      await pool.query(
        `INSERT INTO senders (id, user_id, address, status)
         VALUES ($1, $2, lower($3), 'owner')
         ON CONFLICT (user_id, address) DO UPDATE
           SET status = 'owner', updated_at = now()`,
        [randomUUID(), userId, address]
      );
    }

    console.log(JSON.stringify({ ...summary, seeded: true }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
