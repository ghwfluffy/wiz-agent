import { loadSettings } from "./config/settings.js";
import { createPool } from "./db/pool.js";
import { createPostgresStore } from "./domain/store.js";

const settings = loadSettings();
const pool = createPool(settings);
const store = createPostgresStore(pool);

function logHeartbeat(): void {
  console.log(
    JSON.stringify({
      event: "worker_heartbeat",
      app: "ai-assistant",
      auth_mode: settings.authMode,
      timestamp: new Date().toISOString()
    })
  );
}

logHeartbeat();
setInterval(logHeartbeat, 60_000);

export async function daemonOnce(): Promise<{ ok: true }> {
  await store.getAiConfig();
  logHeartbeat();
  return { ok: true };
}
