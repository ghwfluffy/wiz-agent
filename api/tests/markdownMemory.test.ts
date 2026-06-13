import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { MarkdownConflict, RequestContext } from "../src/domain/types.js";
import { buildApp } from "../src/http/app.js";
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

  it("limits web console markdown edits to assistant instruction files", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "web-knowledge-edit-login");
    const context: RequestContext = {
      userId: session.user.id,
      actorType: "admin",
      permissions: ["user", "admin"],
      requestId: "web-knowledge-edit-test",
      session
    };
    await store.writeMarkdownDocument(context, {
      path: "/assistant/instructions.md",
      markdown: "# Instructions\nBe concise."
    });
    await store.writeMarkdownDocument(context, {
      path: "/newsletters/2026-06-13/source.md",
      markdown: "# Source\nNewsletter content."
    });
    const app = buildApp({ settings, store });
    const headers = {
      cookie: `agent_session=${session.id}`,
      "content-type": "application/json"
    };

    const blocked = await app.request("/api/v1/knowledge/files/%2Fnewsletters%2F2026-06-13%2Fsource.md", {
      method: "PUT",
      headers,
      body: JSON.stringify({ content: "# Source\nEdited." })
    });
    expect(blocked.status).toBe(403);

    const allowed = await app.request("/api/v1/knowledge/files/%2Fassistant%2Finstructions.md", {
      method: "PUT",
      headers,
      body: JSON.stringify({ content: "# Instructions\nBe concise.\nUse bullets.", expectedVersion: 1 })
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      document: {
        path: "/assistant/instructions.md",
        version: 2,
        markdown: expect.stringContaining("Use bullets.")
      }
    });
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

  it("adds, lists, deduplicates, searches, and archives personal memory list items", async () => {
    const { store, context } = await testContext("owner");
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });
    const session = await store.createAgentMcpSession(context, {
      runId: "run-lists",
      ttlSeconds: 60
    });
    const headers = {
      authorization: `Bearer ${session.token}`,
      "x-agent-run-id": "run-lists",
      "content-type": "application/json"
    };

    const add = await app.request("/mcp/v1/tools/add_memory_list_item/call", {
      method: "POST",
      headers,
      body: JSON.stringify({
        listName: "movies",
        item: "Desperado",
        notes: "Antonio Banderas western to watch later.",
        sourceMessageId: "msg-1",
        rationale: "Owner asked to save it to a watch list."
      })
    });
    expect(add.status).toBe(200);
    const addBody = await add.json() as { result: Record<string, unknown> };
    expect(addBody.result).toMatchObject({
      path: "/personal/lists/movies.md",
      duplicate: false,
      item_count: 1
    });
    await expect(store.getMarkdownDocument(context, "/personal/lists/movies.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("<!-- memory-list:v1 list_id=\"movies\" -->")
    });

    const duplicate = await app.request("/mcp/v1/tools/add_memory_list_item/call", {
      method: "POST",
      headers,
      body: JSON.stringify({
        listName: "movie night pile",
        item: "desperado!!!",
        rationale: "Same owner item with inconsistent wording."
      })
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: false,
      sideEffect: "none",
      result: {
        duplicate: true,
        item_count: 1
      }
    });

    const list = await app.request("/mcp/v1/tools/list_memory_items/call", {
      method: "POST",
      headers,
      body: JSON.stringify({
        listName: "watch list"
      })
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody).toMatchObject({
      result: {
        path: "/personal/lists/movies.md",
        items: [
          expect.objectContaining({
            item: "Desperado",
            status: "active",
            notes: "Antonio Banderas western to watch later."
          })
        ]
      }
    });
    expect(listBody.result.items[0].item).not.toContain("memory-list-item");

    const search = await app.request("/mcp/v1/tools/search_memory_lists/call", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "what was that Antonio Banderas movie I wanted to watch?"
      })
    });
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      result: {
        candidates: [
          expect.objectContaining({
            path: "/personal/lists/movies.md",
            confidence: "high",
            matched_items: [
              expect.objectContaining({ item: "Desperado" })
            ]
          })
        ]
      }
    });

    const archive = await app.request("/mcp/v1/tools/remove_memory_list_item/call", {
      method: "POST",
      headers,
      body: JSON.stringify({
        listName: "movies",
        item: "Desperado",
        reason: "Watched.",
        rationale: "Owner asked to remove it after watching."
      })
    });
    expect(archive.status).toBe(200);
    await expect(archive.json()).resolves.toMatchObject({
      result: {
        removed: false,
        archived: true,
        item_count: 0
      }
    });
    await expect(store.getMarkdownDocument(context, "/personal/lists/movies.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("- [x] Desperado")
    });
    const archivedList = await app.request("/mcp/v1/tools/list_memory_items/call", {
      method: "POST",
      headers,
      body: JSON.stringify({
        listName: "movies",
        status: "all"
      })
    });
    expect(archivedList.status).toBe(200);
    await expect(archivedList.json()).resolves.toMatchObject({
      result: {
        items: [
          expect.objectContaining({
            item: "Desperado",
            status: "archived"
          })
        ]
      }
    });
  });

  it("rejects personal list paths outside /personal/lists and keeps lists user scoped", async () => {
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
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });
    const ownerSession = await store.createAgentMcpSession(owner, {
      runId: "run-owner-lists",
      ttlSeconds: 60
    });
    const ownerHeaders = {
      authorization: `Bearer ${ownerSession.token}`,
      "x-agent-run-id": "run-owner-lists",
      "content-type": "application/json"
    };

    const rejected = await app.request("/mcp/v1/tools/list_memory_items/call", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        path: "/personal/profile.md"
      })
    });
    expect(rejected.status).toBe(400);

    await app.request("/mcp/v1/tools/add_memory_list_item/call", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        listName: "restaurants",
        item: "Nopalito",
        rationale: "Owner saved a restaurant."
      })
    });
    await expect(store.getMarkdownDocument(other, "/personal/lists/restaurants.md")).resolves.toBeUndefined();

    const otherMcpSession = await store.createAgentMcpSession(other, {
      runId: "run-other-lists",
      ttlSeconds: 60
    });
    const otherList = await app.request("/mcp/v1/tools/list_memory_items/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${otherMcpSession.token}`,
        "x-agent-run-id": "run-other-lists",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        listName: "restaurants"
      })
    });
    expect(otherList.status).toBe(200);
    await expect(otherList.json()).resolves.toMatchObject({
      result: {
        item_count: 0,
        items: []
      }
    });
  });
});
