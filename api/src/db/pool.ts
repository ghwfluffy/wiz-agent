import { Pool, type PoolConfig, type QueryConfig } from "pg";
import type { Settings } from "../config/settings.js";

export const DATABASE_READINESS_TIMEOUT_MS = 2_000;
export const BACKGROUND_POSTGRES_POOL_OPTIONS: Readonly<Omit<PoolConfig, "connectionString">> = Object.freeze({
  connectionTimeoutMillis: 5_000,
  query_timeout: 20_000,
  statement_timeout: 20_000
});

export function databaseUrl(settings: Settings): string {
  const user = encodeURIComponent(settings.postgresUser);
  const password = encodeURIComponent(settings.postgresPassword);
  return `postgresql://${user}:${password}@${settings.postgresHost}:${settings.postgresPort}/${settings.postgresDb}`;
}

export function createPool(
  settings: Settings,
  options: Omit<PoolConfig, "connectionString"> = {}
): Pool {
  return new Pool({
    ...options,
    connectionString: databaseUrl(settings)
  });
}

export async function checkDatabaseReadiness(
  pool: Pick<Pool, "query">,
  timeoutMs = DATABASE_READINESS_TIMEOUT_MS
): Promise<void> {
  const query = {
    text: "SELECT 1 AS ready",
    query_timeout: timeoutMs
  } as QueryConfig & { query_timeout: number };
  await pool.query(query);
}
