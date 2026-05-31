import { createPool } from "./pool.js";
import { INITIAL_SCHEMA_SQL } from "./schema.js";
import { loadSettings } from "../config/settings.js";

export async function runMigrations(): Promise<void> {
  const settings = loadSettings();
  const pool = createPool(settings);
  try {
    await pool.query(INITIAL_SCHEMA_SQL);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log("Agent database migrations applied.");
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
