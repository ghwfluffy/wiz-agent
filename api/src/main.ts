import { serve } from "@hono/node-server";
import { loadSettings } from "./config/settings.js";
import { buildApp } from "./http/app.js";

const settings = loadSettings();
const app = buildApp({ settings });

serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: 8000
});

console.log(`AI Assistant API listening on 0.0.0.0:8000 in ${settings.authMode} mode`);
