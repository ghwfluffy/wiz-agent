import { createPool } from "./pool.js";
import { INITIAL_SCHEMA_SQL } from "./schema.js";
import { loadSettings } from "../config/settings.js";
import { COLLAPSE_TENANT_TO_USER_MIGRATION_ID, COLLAPSE_TENANT_TO_USER_SQL } from "./migrations.js";

export async function runMigrations(): Promise<void> {
  const settings = loadSettings();
  const pool = createPool(settings);
  try {
    await pool.query(INITIAL_SCHEMA_SQL);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [
      COLLAPSE_TENANT_TO_USER_MIGRATION_ID
    ]);
    if (applied.rowCount === 0) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const duplicateSenders = await client.query<{ user_id: string; address: string; count: string }>(`
          SELECT user_id, lower(address) AS address, count(*)::text AS count
          FROM senders
          GROUP BY user_id, lower(address)
          HAVING count(*) > 1
        `);
        if (duplicateSenders.rows.length > 0) {
          throw new Error(
            `Cannot apply ${COLLAPSE_TENANT_TO_USER_MIGRATION_ID}: duplicate sender addresses exist for a user.`
          );
        }

        const duplicateMemory = await client.query<{ user_id: string; slug: string; count: string }>(`
          SELECT user_id, slug, count(*)::text AS count
          FROM memory_documents
          GROUP BY user_id, slug
          HAVING count(*) > 1
        `);
        if (duplicateMemory.rows.length > 0) {
          throw new Error(
            `Cannot apply ${COLLAPSE_TENANT_TO_USER_MIGRATION_ID}: duplicate memory document slugs exist for a user.`
          );
        }

        await client.query(COLLAPSE_TENANT_TO_USER_SQL);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
          COLLAPSE_TENANT_TO_USER_MIGRATION_ID
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
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
