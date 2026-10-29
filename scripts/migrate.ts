import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL_UNPOOLED)
  throw new Error("Configura DATABASE_URL_UNPOOLED.");
if (new URL(process.env.DATABASE_URL_UNPOOLED).hostname.includes("-pooler"))
  throw new Error("Las migraciones requieren una conexión directa.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const c = await pool.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(483721)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (
      (
        await c.query("SELECT name FROM schema_migrations WHERE name=$1", [
          name,
        ])
      ).rowCount
    )
      continue;
    await c.query(await readFile(`migrations/${name}`, "utf8"));
    await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    console.log("Migración aplicada:", name);
  }
  await c.query("COMMIT");
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  c.release();
  await pool.end();
}
