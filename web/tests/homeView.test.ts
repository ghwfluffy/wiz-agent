import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HomeView from "../src/views/HomeView.vue";

describe("home view", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
  });

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
      });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(HomeView);
    await flushPromises();

    expect(wrapper.text()).toContain("Check in");
    expect(wrapper.text()).toContain("sms");
    expect(wrapper.text()).toContain("sms@example.test");
    expect(wrapper.text()).toContain("Overview");
    expect(wrapper.text()).toContain("Inbox");
    expect(wrapper.text()).toContain("Outbox");
    expect(wrapper.text()).toContain("Tasks");
    expect(wrapper.text()).toContain("Audit events");
    expect(wrapper.text()).toContain("owner@example.test");
    expect(wrapper.text()).toContain("AI configuration");
    expect(wrapper.text()).toContain("please approve");
    expect(wrapper.text()).toContain("sent@example.test");
    expect(wrapper.text()).toContain("SMTP error");
  });
});
