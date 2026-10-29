import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRecovery } from "../src/lib/sessionRecovery";

afterEach(() => { vi.unstubAllGlobals(); });
describe("background session recovery", () => {
  it("shares recovery and retries rejected requests without navigation", async () => {
    vi.stubGlobal("window", { location: { href: "https://example.test/app/", origin: "https://example.test" } });
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetcher);
    const recover = createSessionRecovery(() => "/app/api/auth/login");
    const first = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValue({ status: 200 });
    const second = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValue({ status: 200 });
    expect(await Promise.all([recover(first), recover(second)])).toEqual([{ status: 200 }, { status: 200 }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
  it("bounds failed recovery to one retry", async () => {
    vi.stubGlobal("window", { location: { href: "https://example.test/app/", origin: "https://example.test" } });
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetcher);
    const send = vi.fn().mockResolvedValue({ status: 401 });
    expect(await createSessionRecovery(() => "/login")(send)).toEqual({ status: 401 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("leaves permission errors, logout, and local auth alone", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const recover = createSessionRecovery(() => "/login");
    await recover(async () => ({ status: 403 }));
    await recover(async () => ({ status: 401 }), false);
    await createSessionRecovery(() => "/login", false)(async () => ({ status: 401 }));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
