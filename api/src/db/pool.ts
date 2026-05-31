import { Pool } from "pg";
import type { Settings } from "../config/settings.js";

export function databaseUrl(settings: Settings): string {
  const user = encodeURIComponent(settings.postgresUser);
  const password = encodeURIComponent(settings.postgresPassword);
  return `postgresql://${user}:${password}@${settings.postgresHost}:${settings.postgresPort}/${settings.postgresDb}`;
}

export function createPool(settings: Settings): Pool {
  return new Pool({
    connectionString: databaseUrl(settings)
  });
}
