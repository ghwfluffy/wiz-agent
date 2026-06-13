import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { MarkdownConflict, RequestContext } from "../src/domain/types.js";
import { buildMcpApp } from "../src/mcp/server.js";

function isConflict(value: unknown): value is MarkdownConflict {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "conflict";
}

async function testContext(userId: string): Promise<{ store: ReturnType<typeof createMemoryStore>; context: RequestContext }> {
  const store = createMemoryStore();
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone",
    DEV_USER_ID: userId,
    DEV_USER_EMAIL: `${userId}@example.test`
  });
  const session = await store.createDevelopmentSession(settings, `${userId}-login`);
  return {
    store,
    context: {
      userId: session.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: `${userId}-request`,
      session
    }
  };
}

describe("markdown memory filesystem", () => {
  it("creates sections and index jobs on write", async () => {
    const { store, context } = await testContext("owner");

    const document = await store.writeMarkdownDocument(context, {
      path: "/personal/profile.md",
      markdown: "intro\n\n# Goals\n\n## MVP\nShip the first pass."
    });

    expect(isConflict(document)).toBe(false);
    if (isConflict(document)) {
      return;
    }
    expect(document.version).toBe(1);
    await expect(store.listMarkdownSections(context, "/personal/profile.md")).resolves.toMatchObject([
      { sectionId: "_preamble", lineStart: 1 },
      { sectionId: "goals", headingPath: ["Goals"] },
      { sectionId: "goals/mvp", parentSectionId: "goals" }
    ]);
    await expect(store.getMarkdownIndexStatus(context, "/personal")).resolves.toEqual([
      expect.objectContaining({
        path: "/personal/profile.md",
        version: 1,
        pendingJobs: 1
      })
    ]);
  });

  it("preserves user ownership boundaries for markdown paths", async () => {
    const { store, context: owner } = await testContext("owner");
    const otherSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "other",
      DEV_USER_EMAIL: "other@example.test"
    });
    const otherSession = await store.createDevelopmentSession(otherSettings, "other-login");
    const other: RequestContext = {
      userId: otherSession.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: "other-request",
      session: otherSession
    };

    await store.writeMarkdownDocument(owner, {
      path: "/assistant/schedule.md",
      markdown: "# Schedule\nOwner only."
    });

    await expect(store.getMarkdownDocument(other, "/assistant/schedule.md")).resolves.toBeUndefined();
    await expect(store.listMarkdownDirectory(other, "/assistant")).resolves.toEqual([]);
  });

  it("replaces only the target section and returns conflicts for stale versions", async () => {
    const { store, context } = await testContext("owner");
    const created = await store.writeMarkdownDocument(context, {
      path: "/projects/alpha/decisions.md",
      markdown: "# Alpha\nKeep.\n\n## Decision\nOld decision.\n\n## Notes\nLeave alone."
    });
    expect(isConflict(created)).toBe(false);
    if (isConflict(created)) {
      return;
    }

    const replaced = await store.replaceMarkdownSection(
      context,
      "/projects/alpha/decisions.md",
      "alpha/decision",
      "## Decision\nNew decision.",
      created.version
    );
    expect(isConflict(replaced)).toBe(false);
    if (!replaced || isConflict(replaced)) {
      return;
    }
    expect(replaced.markdown).toContain("New decision.");
    expect(replaced.markdown).toContain("## Notes\nLeave alone.");

    const stale = await store.replaceMarkdownSection(
      context,
      "/projects/alpha/decisions.md",
      "alpha/notes",
      "## Notes\nChanged.",
      created.version
    );
    expect(stale).toEqual({
      code: "conflict",
      path: "/projects/alpha/decisions.md",
      expectedVersion: 1,
      actualVersion: 2
    });
  });

  it("moves path trees, queues reindex jobs, and omits deleted files from directories", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/projects/alpha/decisions.md",
      markdown: "# Decisions"
    });
    await store.writeMarkdownDocument(context, {
      path: "/projects/alpha/notes.md",
      markdown: "# Notes"
    });

    const moved = await store.moveMarkdownPath(context, {
      from: "/projects/alpha",
      to: "/projects/beta"
    });
    expect(isConflict(moved)).toBe(false);
    expect(moved).toEqual([
      expect.objectContaining({ path: "/projects/beta/decisions.md", version: 2 }),
      expect.objectContaining({ path: "/projects/beta/notes.md", version: 2 })
    ]);
    await expect(store.listMarkdownDirectory(context, "/projects/alpha")).resolves.toEqual([]);
    await expect(store.getMarkdownIndexStatus(context, "/projects/beta")).resolves.toEqual([
      expect.objectContaining({ path: "/projects/beta/decisions.md", pendingJobs: 2 }),
      expect.objectContaining({ path: "/projects/beta/notes.md", pendingJobs: 2 })
    ]);

    const deleted = await store.deleteMarkdownPath(context, "/projects/beta/notes.md");
    expect(deleted).toBe(true);
    await expect(store.listMarkdownDirectory(context, "/projects/beta")).resolves.toEqual([
      expect.objectContaining({ path: "/projects/beta/decisions.md" })
    ]);
  });

  it("greps plain text and regex patterns", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/preferences/newsletters.md",
      markdown: "# Newsletters\nPrefer concise AI summaries.\nAvoid hype."
    });

    await expect(store.grepMarkdown(context, {
      pattern: "ai summaries",
      caseSensitive: false
    })).resolves.toEqual([
      expect.objectContaining({
        path: "/preferences/newsletters.md",
        line: 2
      })
    ]);
    await expect(store.grepMarkdown(context, {
      pattern: "Avoid\\s+hype",
      regex: true
    })).resolves.toEqual([
      expect.objectContaining({
        path: "/preferences/newsletters.md",
        line: 3
      })
    ]);
  });
});

describe("MCP markdown tools", () => {
  it("rejects missing sessions and resolves user context server-side", async () => {
    const { store, context } = await testContext("owner");
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });

    const missingAuth = await app.request("/mcp/v1/tools/list_dir", {
      method: "POST",
      body: JSON.stringify({ path: "/" })
    });
    expect(missingAuth.status).toBe(401);

    const session = await store.createAgentMcpSession(context, {
      runId: "run-1",
      ttlSeconds: 60
    });
    const write = await app.request("/mcp/v1/tools/write_file", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-agent-run-id": "run-1",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/assistant/notification-policy.md",
        content: "# Notification Policy\nUse discretion.",
        userId: "other"
      })
    });
    expect(write.status).toBe(200);
    await expect(store.getMarkdownDocument(context, "/assistant/notification-policy.md")).resolves.toMatchObject({
      userId: "owner",
      version: 1
    });

    const wrongRun = await app.request("/mcp/v1/tools/list_dir", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-agent-run-id": "run-2"
      },
      body: JSON.stringify({ path: "/" })
    });
    expect(wrongRun.status).toBe(401);

    const missingRun = await app.request("/mcp/v1/tools/list_dir", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`
      },
      body: JSON.stringify({ path: "/" })
    });
    expect(missingRun.status).toBe(401);
  });

  it("searches markdown headings through MCP", async () => {
    const { store, context } = await testContext("owner");
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });
    await store.writeMarkdownDocument(context, {
      path: "/projects/alpha/overview.md",
      markdown: "# Alpha\n\n## Deployment Plan\nShip carefully.\n\n## Notes\nKeep short."
    });
    const session = await store.createAgentMcpSession(context, {
      ttlSeconds: 60
    });

    const response = await app.request("/mcp/v1/tools/search_headings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: "deployment",
        pathPrefix: "/projects",
        maxDepth: 2
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: {
        matches: [
          expect.objectContaining({
            path: "/projects/alpha/overview.md",
            sectionId: "alpha/deployment-plan",
            heading: "Deployment Plan",
            level: 2
          })
        ]
      }
    });
  });
});
