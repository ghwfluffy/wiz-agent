// Restore the app cookie through OAuth without navigating the visible page.
export function createSessionRecovery(loginUrl: () => string, enabled = true) {
  let pending: Promise<void> | null = null;
  let generation = 0;
  return async function withSessionRecovery<T extends { status: number }>(send: () => Promise<T>, eligible = true, expired: (response: T) => Promise<boolean> = async response => response.status === 401) {
    const started = generation;
    const response = await send();
    if (!enabled || !eligible || !(await expired(response))) return response;
    if (started === generation) {
      if (!pending) {
        pending = (async () => {
          try {
            const url = new URL(loginUrl(), window.location.href);
            if (url.origin !== window.location.origin) return;
            await fetch(url, {
              credentials: "same-origin", cache: "no-store",
              signal: AbortSignal.timeout(10000),
            });
            generation += 1;
          } catch {
            // The single retry below decides whether authentication was restored.
          }
        })().finally(() => { pending = null; });
      }
      await pending;
    }
    return send();
  };
}
