import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const appBasePath = process.env.VITE_APP_BASE_PATH || "/";
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || "http://localhost:8000";

export default defineConfig({
  base: appBasePath === "" ? "/" : appBasePath,
  plugins: [vue()],
  resolve: {
    alias: {
      "@": "/src"
    }
  },
  server: {
    port: 8081,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true
      }
    }
  },
  test: {
    environment: "jsdom",
    globals: true
  }
});
