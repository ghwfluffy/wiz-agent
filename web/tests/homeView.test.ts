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
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [document] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [document] }) });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = await mountHome("/?tab=memory");
    await flushPromises();

    expect(wrapper.get("#tab-memory").attributes("aria-selected")).toBe("true");
    expect(wrapper.text()).toContain("Newsletter Preferences");
    expect(wrapper.text()).toContain("newsletter-preferences");
    expect(wrapper.text()).toContain("Useful security writeups");
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
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connectors: [connector] }) })
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
      .mockResolvedValueOnce({ ok: true, json: async () => connector })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connectors: [connector] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          configured: true,
          error: { response: "NO IMAP disabled" }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          events: [{ id: "audit-1", action: "connector.imap_test.failed", entityType: "connector", entityId: "imap", details: { error: { response: "NO IMAP disabled" } }, createdAt: "" }]
        })
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
});
