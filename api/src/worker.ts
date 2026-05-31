import { loadSettings } from "./config/settings.js";

const settings = loadSettings();

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
