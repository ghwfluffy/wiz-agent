import type { Settings } from "../config/settings.js";

export function qdrantCollectionForUser(userId: string): string {
  return `user_${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}_rag`;
}

export async function qdrantHealth(settings: Settings, fetchImpl: typeof fetch = fetch): Promise<{
  ok: boolean;
  status?: number;
}> {
  const response = await fetchImpl(`${settings.qdrantUrl.replace(/\/$/, "")}/healthz`).catch(() => undefined);
  return {
    ok: response?.ok === true,
    status: response?.status
  };
}
