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
          user: { id: "u1", email: "u@example.test", displayName: "User", isAdmin: true },
          tenant: { id: "t1", name: "Tenant" }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tasks: [{ id: "task-1", title: "Check in", prompt: "Run", status: "pending", dueAt: null, priority: 0 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-1", channel: "sms", status: "sent", toAddr: "sms@example.test", bodyText: "hi", createdAt: "", updatedAt: "" }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [{ id: "evt-1", action: "task.create", entityType: "task", entityId: "task-1", createdAt: "" }] })
      });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(HomeView);
    await flushPromises();

    expect(wrapper.text()).toContain("Check in");
    expect(wrapper.text()).toContain("sms to sms@example.test");
    expect(wrapper.text()).toContain("Audit events");
  });
});
