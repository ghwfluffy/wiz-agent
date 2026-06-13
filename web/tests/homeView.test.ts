import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeView from "../src/views/HomeView.vue";

describe("home view", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function mountHome(path = "/") {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: HomeView }]
    });
    router.push(path);
    await router.isReady();
    const wrapper = mount(HomeView, {
      global: {
        plugins: [router]
      }
    });
    return { router, wrapper };
  }

  it("loads operational dashboard data after restoring an authenticated session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authenticated: true,
          user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tasks: [{ id: "task-1", title: "Check in", prompt: "Run", status: "pending", dueAt: null, priority: 0 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{
            id: "in-1",
            providerMessageId: "provider-1",
            fromAddr: "owner@example.test",
            toAddr: "agent@example.test",
            subject: "Task update",
            bodyText: "please keep going",
            source: "sms",
            classification: "owner",
            handlingAction: "routed_to_agent",
            taskId: "task-1",
            taskEventId: "event-1",
            agentRunId: "run-1",
            outboundMessageId: null,
            receivedAt: "",
            createdAt: ""
          }, {
            id: "in-2",
            providerMessageId: "provider-2",
            fromAddr: "unknown@example.test",
            toAddr: "agent@example.test",
            subject: "Unknown sender",
            bodyText: "hello",
            source: "email",
            classification: "untrusted",
            handlingAction: "queued_owner_review",
            taskId: null,
            taskEventId: null,
            agentRunId: null,
            outboundMessageId: null,
            receivedAt: "",
            createdAt: ""
          }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [
            { id: "msg-1", channel: "sms", status: "requires_approval", toAddr: "sms@example.test", bodyText: "please approve", createdAt: "", updatedAt: "" },
            { id: "msg-2", channel: "sms", status: "sent", toAddr: "sent@example.test", bodyText: "sent message", createdAt: "", updatedAt: "", sentAt: "" },
            { id: "msg-3", channel: "email", status: "failed", toAddr: "failed@example.test", bodyText: "failed message", createdAt: "", updatedAt: "", failureMessage: "SMTP error" }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [{ id: "evt-1", action: "task.create", entityType: "task", entityId: "task-1", createdAt: "" }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ senders: [{ id: "sender-1", address: "owner@example.test", status: "owner", createdAt: "", updatedAt: "" }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connectors: [
            { id: "connector-1", kind: "imap", status: "enabled", config: { username: "agent@example.test", imap: { host: "imap.example.test", port: 993, secure: true, mailbox: "INBOX", password_set: true } }, createdAt: "", updatedAt: "" },
            { id: "connector-2", kind: "smtp", status: "enabled", config: { username: "agent@example.test", smtp: { host: "smtp.example.test", port: 587, secure: false, from: "agent@example.test", password_set: true } }, createdAt: "", updatedAt: "" }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fastModel: "gpt-5-mini",
          smartModel: "gpt-5",
          orchestratorModel: "gpt-5",
          repairModel: "gpt-5-mini",
          maxToolCalls: 10,
          maxRuntimeSec: 120,
          repairAttemptLimit: 1
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jobs: [{ name: "outbox", status: "configured", pendingMessages: 1 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documents: [{ id: "mem-1", slug: "newsletter-preferences", title: "Newsletter Preferences", body: "# Newsletter Preferences\n\n- Useful security writeups.", createdAt: "", updatedAt: "" }]
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome();
    await flushPromises();

    expect(wrapper.text()).toContain("Check in");
    expect(wrapper.text()).toContain("sms");
    expect(wrapper.text()).toContain("sms@example.test");
    expect(wrapper.text()).toContain("Overview");
    expect(wrapper.text()).toContain("Inbox");
    expect(wrapper.text()).toContain("Outbox");
    expect(wrapper.text()).toContain("Tasks");
    expect(wrapper.text()).toContain("Memory");
    expect(wrapper.text()).toContain("Settings");
    expect(wrapper.text()).toContain("Audit events");
    expect(wrapper.text()).toContain("owner@example.test");
    expect(wrapper.text()).toContain("AI configuration");
    expect(wrapper.text()).toContain("Account settings");
    expect(wrapper.text()).toContain("please approve");
    expect(wrapper.text()).toContain("Owner review not sent");
    expect(wrapper.text()).toContain("Notify owner");
    expect(wrapper.text()).toContain("sent@example.test");
    expect(wrapper.text()).toContain("SMTP error");
    expect(wrapper.text()).toContain("Newsletter Preferences");
  });

  it("keeps the active dashboard tab in the route query", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authenticated: true,
          user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true }
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tasks: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ senders: [{ id: "sender-1", address: "news@example.test", status: "newsletter", createdAt: "", updatedAt: "" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connectors: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fastModel: "gpt-5-mini",
          smartModel: "gpt-5",
          orchestratorModel: "gpt-5",
          repairModel: "gpt-5-mini",
          maxToolCalls: 10,
          maxRuntimeSec: 120,
          repairAttemptLimit: 1
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobs: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const { router, wrapper } = await mountHome("/?tab=outbox");
    await flushPromises();

    expect(wrapper.get("#tab-outbox").attributes("aria-selected")).toBe("true");

    await wrapper.get("#tab-inbox").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.tab).toBe("inbox");
    expect(wrapper.get("#tab-inbox").attributes("aria-selected")).toBe("true");
  });

  it("keeps account connector settings on a user settings tab", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authenticated: true,
          user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true }
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tasks: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ senders: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connectors: [
            { id: "connector-1", kind: "owner-contact", status: "enabled", config: { name: "User", email: "u@example.test" }, createdAt: "", updatedAt: "" }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fastModel: "gpt-5-mini",
          smartModel: "gpt-5",
          orchestratorModel: "gpt-5",
          repairModel: "gpt-5-mini",
          maxToolCalls: 10,
          maxRuntimeSec: 120,
          repairAttemptLimit: 1
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobs: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connectors: [
            { id: "connector-1", kind: "owner-contact", status: "enabled", config: { name: "User", email: "u@example.test" }, createdAt: "", updatedAt: "" }
          ]
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=settings");
    await flushPromises();

    expect(wrapper.get("#tab-settings").attributes("aria-selected")).toBe("true");
    expect(wrapper.text()).toContain("Account settings");
    expect(wrapper.text()).toContain("Owner contact");
    expect(wrapper.text()).toContain("IMAP inbox");
    expect(wrapper.text()).toContain("SMTP outbox");
  });

  it("shows a searchable memory browser tab", async () => {
    const document = {
      id: "mem-1",
      slug: "newsletter-preferences",
      title: "Newsletter Preferences",
      body: "# Newsletter Preferences\n\n- Useful security writeups.\n- Weird infrastructure failures.",
      createdAt: "",
      updatedAt: ""
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return { ok: true, json: async () => ({ authenticated: true, user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true } }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [document] }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: [{ id: "sender-1", address: "news@example.test", status: "newsletter", createdAt: "", updatedAt: "" }] }) };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [] }) };
      }
      if (url.includes("/messages") || url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/audit")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=memory");
    await flushPromises();

    expect(wrapper.get("#tab-memory").attributes("aria-selected")).toBe("true");
    expect(wrapper.text()).toContain("Trusted contacts");
    expect(wrapper.text()).toContain("news@example.test");
    expect(wrapper.text()).toContain("Newsletter Preferences");
    expect(wrapper.text()).toContain("newsletter-preferences");
    expect(wrapper.text()).toContain("Useful security writeups");
  });

  it("manages trusted contacts from the memory tab", async () => {
    let senderState = [{ id: "sender-1", address: "owner@example.test", status: "owner", createdAt: "", updatedAt: "" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return { ok: true, json: async () => ({ authenticated: true, user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true } }) };
      }
      if (url.includes("/senders/friend%40example.test") && init?.method === "PUT") {
        senderState = [{ id: "sender-2", address: "friend@example.test", status: "trusted", createdAt: "", updatedAt: "" }];
        return { ok: true, json: async () => ({ senders: senderState }) };
      }
      if (url.includes("/senders/friend%40example.test") && init?.method === "DELETE") {
        senderState = [];
        return { ok: true, json: async () => ({ senders: senderState }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: senderState }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [] }) };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [] }) };
      }
      if (url.includes("/messages") || url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/audit")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { wrapper } = await mountHome("/?tab=memory");
    await flushPromises();

    await wrapper.get("#memory-sender-address").setValue("friend@example.test");
    await wrapper.get("#memory-sender-status").setValue("trusted");
    await wrapper.get("form.contact-form").trigger("submit");
    await flushPromises();

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/senders/friend%40example.test"))).toBe(true);
    expect(wrapper.text()).toContain("friend@example.test");

    const removeButton = wrapper.findAll("button").find((button) => button.text() === "Remove");
    expect(removeButton).toBeTruthy();
    await removeButton!.trigger("click");
    await flushPromises();

    const deleteCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/senders/friend%40example.test") && (call[1] as RequestInit | undefined)?.method === "DELETE");
    expect(deleteCall).toBeTruthy();
  });

  it("shows IMAP test failures from the settings tab", async () => {
    const connector = {
      id: "connector-1",
      kind: "imap",
      status: "enabled",
      config: {
        username: "agent@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, mailbox: "INBOX", password_set: true }
      },
      createdAt: "",
      updatedAt: ""
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return {
          ok: true,
          json: async () => ({
            authenticated: true,
            user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true }
          })
        };
      }
      if (url.includes("/connectors/imap/test")) {
        return {
          ok: true,
          json: async () => ({
            ok: false,
            configured: true,
            error: { response: "NO IMAP disabled" }
          })
        };
      }
      if (url.includes("/connectors/imap") && init?.method === "PUT") {
        return { ok: true, json: async () => connector };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [connector] }) };
      }
      if (url.includes("/audit")) {
        return {
          ok: true,
          json: async () => ({
            events: [{ id: "audit-1", action: "connector.imap_test.failed", entityType: "connector", entityId: "imap", details: { error: { response: "NO IMAP disabled" } }, createdAt: "" }]
          })
        };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [] }) };
      }
      if (url.includes("/messages") || url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: [] }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=settings");
    await flushPromises();

    const testButton = wrapper.findAll("button").find((button) => button.text() === "Test IMAP");
    expect(testButton).toBeTruthy();
    await testButton!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("IMAP test failed");
    expect(wrapper.text()).toContain("NO IMAP disabled");
  });

  it("renders approval inbox and calls approve/edit APIs", async () => {
    const approval = {
      id: "approval-1",
      status: "pending",
      actionType: "send_outbound_message",
      sourceRunId: "run-1",
      sourceRef: "sms",
      proposedPayload: { body_text: "Original message", channel: "sms" },
      riskLevel: "high",
      summary: "Send SMS owner message",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestedBy: "agent",
      decidedBy: null,
      decidedAt: null,
      createdAt: "",
      updatedAt: ""
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return {
          ok: true,
          json: async () => ({
            authenticated: true,
            user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true }
          })
        };
      }
      if (url.includes("/approvals/approval-1") && init?.method === "PATCH") {
        return { ok: true, json: async () => ({ approval }) };
      }
      if (url.includes("/approvals")) {
        return { ok: true, json: async () => ({ approvals: [approval] }) };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [] }) };
      }
      if (url.includes("/messages") || url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: [] }) };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [] }) };
      }
      if (url.includes("/audit")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=approvals");
    await flushPromises();

    expect(wrapper.text()).toContain("Approval inbox");
    expect(wrapper.text()).toContain("Send SMS owner message");
    expect(wrapper.text()).toContain("Original message");

    const textarea = wrapper.get("#approval-edit-approval-1");
    (textarea.element as HTMLTextAreaElement).value = "Edited message";
    await textarea.trigger("input");
    const saveEdit = wrapper.findAll("button").find((button) => button.text() === "Save edit");
    expect(saveEdit).toBeTruthy();
    await saveEdit!.trigger("click");
    await flushPromises();

    const approve = wrapper.findAll("button").find((button) => button.text() === "Approve");
    expect(approve).toBeTruthy();
    await approve!.trigger("click");
    await flushPromises();

    const patchBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes("/approvals/approval-1"))
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(patchBodies).toEqual(expect.arrayContaining([
      { decision: "approve" },
      { decision: "edit", text: "Edited message" }
    ]));
  });

  it("polls only the active tab data every ten seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authenticated: true,
          user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true }
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tasks: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ senders: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connectors: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fastModel: "gpt-5-mini",
          smartModel: "gpt-5",
          orchestratorModel: "gpt-5",
          repairModel: "gpt-5-mini",
          maxToolCalls: 10,
          maxRuntimeSec: 120,
          repairAttemptLimit: 1
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobs: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=outbox");
    await flushPromises();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) });

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/outbox");

    wrapper.unmount();
  });

  it("submits direct agent prompts with selected context and renders the run result", async () => {
    const task = { id: "task-1", title: "Plan trip", prompt: "Plan", status: "pending", dueAt: null, priority: 0 };
    const message = {
      id: "in-1",
      providerMessageId: "provider-1",
      fromAddr: "owner@example.test",
      toAddr: "agent@example.test",
      subject: "Trip",
      bodyText: "remember the hotel",
      source: "email",
      classification: "owner",
      handlingAction: "routed_to_agent",
      taskId: "task-1",
      taskEventId: null,
      agentRunId: "run-old",
      outboundMessageId: null,
      receivedAt: "",
      createdAt: ""
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return { ok: true, json: async () => ({ authenticated: true, user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true } }) };
      }
      if (url.includes("/agent/prompts") && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            runId: "run-123",
            status: "completed",
            selectedAction: "create_task",
            toolStatus: "accepted",
            repaired: false,
            toolResult: { task_id: "task-2" },
            links: { taskId: "task-2", taskEventId: null, outboundMessageId: null, memoryDocumentId: null, memorySlug: null, clarificationRequestId: null },
            failureMessage: null
          })
        };
      }
      if (url.includes("/knowledge/tree")) {
        return {
          ok: true,
          json: async () => ({
            path: "/",
            entries: [{ path: "/assistant/context.md", name: "context.md", type: "file", version: 1, updatedAt: "" }]
          })
        };
      }
      if (url.includes("/knowledge/files/%2Fassistant%2Fcontext.md/sections")) {
        return { ok: true, json: async () => ({ sections: [] }) };
      }
      if (url.includes("/knowledge/files/%2Fassistant%2Fcontext.md")) {
        return { ok: true, json: async () => ({ document: { id: "doc-1", path: "/assistant/context.md", basename: "context.md", title: "Context", markdown: "# Context", contentHash: "hash", version: 1, indexStatus: "indexed", createdAt: "", updatedAt: "" } }) };
      }
      if (url.includes("/tasks/task-2/events")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [task, { ...task, id: "task-2", title: "Created task" }] }) };
      }
      if (url.includes("/messages")) {
        return { ok: true, json: async () => ({ messages: [message] }) };
      }
      if (url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/audit")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: [] }) };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [] }) };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome();
    await flushPromises();

    await wrapper.get("#tab-chat").trigger("click");
    await flushPromises();
    await wrapper.get("#chat-agent-prompt").setValue("Create a packing task.");
    await wrapper.get("#chat-prompt-mode").setValue("planning");
    await wrapper.get("#chat-prompt-task").setValue("task-1");
    await wrapper.get("#chat-prompt-memory").setValue("/assistant/context.md");
    await wrapper.get("#chat-prompt-message").setValue("in-1");
    await wrapper.get("#panel-chat form").trigger("submit");
    await flushPromises();

    const promptCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/agent/prompts"));
    expect(promptCall).toBeTruthy();
    const body = JSON.parse(String((promptCall?.[1] as RequestInit).body));
    expect(body).toMatchObject({ mode: "planning", contextTaskId: "task-1" });
    expect(body.prompt).toContain("Selected memory path: /assistant/context.md");
    expect(body.prompt).toContain("Selected recent assistant mailbox message: in-1");
    expect(body.prompt).toContain("Create a packing task.");
    expect(wrapper.text()).toContain("run-123");
    expect(wrapper.text()).toContain("create_task");
    expect(wrapper.text()).toContain("Created task");
  });

  it("shows task schedule intelligence details in the task modal", async () => {
    const task = {
      id: "task-1",
      title: "Review vendor proposal",
      prompt: "Review the quote when it arrives.",
      status: "waiting",
      dueAt: "2026-06-15T14:00:00.000Z",
      priority: 4,
      updatedAt: "",
      scheduleRationale: "Wait until the vendor sends final pricing.",
      nextReviewAt: "2026-06-14T14:00:00.000Z",
      lastAgentReviewAt: "2026-06-13T14:00:00.000Z",
      waitingOn: "vendor pricing",
      blockedReason: "External quote missing.",
      recurrencePolicy: "review daily until quote arrives",
      sourceMemoryPath: "/tasks/schedule-rationale.md",
      ownerClarificationNeeded: true
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return { ok: true, json: async () => ({ authenticated: true, user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true } }) };
      }
      if (url.includes("/tasks/task-1/events")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [task] }) };
      }
      if (url.includes("/messages") || url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/audit")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: [] }) };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [] }) };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=tasks");
    await flushPromises();
    await wrapper.findAll("button").find((button) => button.text() === "View")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Schedule intelligence");
    expect(wrapper.text()).toContain("Wait until the vendor sends final pricing.");
    expect(wrapper.text()).toContain("vendor pricing");
    expect(wrapper.text()).toContain("External quote missing.");
    expect(wrapper.text()).toContain("review daily until quote arrives");
    expect(wrapper.text()).toContain("/tasks/schedule-rationale.md");
    expect(wrapper.text()).toContain("Needed");
  });

  it("uses assistant mailbox language for the agent inbox", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return { ok: true, json: async () => ({ authenticated: true, user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true } }) };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/messages") || url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [] }) };
      }
      if (url.includes("/audit")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: [] }) };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [] }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=inbox");
    await flushPromises();

    expect(wrapper.get("#tab-inbox").text()).toBe("Agent Inbox");
    expect(wrapper.text()).toContain("No messages received by the assistant mailbox.");
  });

  it("loads knowledge tree files and saves editable assistant markdown", async () => {
    const originalDocument = {
      id: "doc-1",
      path: "/assistant/instructions.md",
      basename: "instructions.md",
      title: "Instructions",
      markdown: "# Instructions\n\nKeep replies concise.",
      contentHash: "hash-1",
      version: 1,
      indexStatus: "indexed",
      createdAt: "",
      updatedAt: ""
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return { ok: true, json: async () => ({ authenticated: true, user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true } }) };
      }
      if (url.includes("/knowledge/tree")) {
        return {
          ok: true,
          json: async () => ({
            path: "/",
            entries: [{
              path: "/assistant",
              name: "assistant",
              type: "directory",
              children: [{ path: "/assistant/instructions.md", name: "instructions.md", type: "file", version: 1, updatedAt: "" }]
            }]
          })
        };
      }
      if (url.includes("/knowledge/files/%2Fassistant%2Finstructions.md/sections")) {
        return { ok: true, json: async () => ({ sections: [{ id: "sec-1", documentId: "doc-1", documentVersion: 1, sectionId: "instructions", parentSectionId: null, heading: "Instructions", headingPath: ["Instructions"], level: 1, lineStart: 1, lineEnd: 3, contentHash: "hash" }] }) };
      }
      if (url.includes("/knowledge/files/%2Fassistant%2Finstructions.md") && init?.method === "PUT") {
        return { ok: true, json: async () => ({ document: { ...originalDocument, markdown: "# Instructions\n\nKeep replies concise.\nUse bullets.", version: 2 } }) };
      }
      if (url.includes("/knowledge/files/%2Fassistant%2Finstructions.md")) {
        return { ok: true, json: async () => ({ document: originalDocument }) };
      }
      if (url.includes("/admin/ai-config")) {
        return { ok: true, json: async () => ({ fastModel: "gpt-5-mini", smartModel: "gpt-5", orchestratorModel: "gpt-5", repairModel: "gpt-5-mini", maxToolCalls: 10, maxRuntimeSec: 120, repairAttemptLimit: 1 }) };
      }
      if (url.includes("/admin/jobs")) {
        return { ok: true, json: async () => ({ jobs: [] }) };
      }
      if (url.includes("/messages") || url.includes("/outbox")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/tasks")) {
        return { ok: true, json: async () => ({ tasks: [] }) };
      }
      if (url.includes("/audit")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/senders")) {
        return { ok: true, json: async () => ({ senders: [] }) };
      }
      if (url.includes("/connectors")) {
        return { ok: true, json: async () => ({ connectors: [] }) };
      }
      if (url.includes("/memory")) {
        return { ok: true, json: async () => ({ documents: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome();
    await flushPromises();

    await wrapper.get("#tab-memory").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("/assistant/instructions.md");
    expect(wrapper.text()).toContain("Keep replies concise.");
    expect(wrapper.text()).toContain("indexed");

    await wrapper.findAll("button").find((button) => button.text() === "Edit")!.trigger("click");
    await wrapper.get("#knowledge-draft").setValue("# Instructions\n\nKeep replies concise.\nUse bullets.");
    await wrapper.findAll("button").find((button) => button.text() === "Save file")!.trigger("click");
    await flushPromises();

    const saveCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/knowledge/files/%2Fassistant%2Finstructions.md") && (call[1] as RequestInit | undefined)?.method === "PUT");
    expect(saveCall).toBeTruthy();
    expect(JSON.parse(String((saveCall?.[1] as RequestInit).body))).toMatchObject({ expectedVersion: 1 });
    expect(wrapper.text()).toContain("Use bullets.");
  });
});
