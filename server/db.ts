import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;
let pool: Pool | undefined;
export function database() {
  if (!process.env.DATABASE_URL)
    throw new Error("Falta configurar DATABASE_URL en el servidor.");
  if (
    process.env.CONTEXT === "deploy-preview" ||
    process.env.CONTEXT === "branch-deploy"
  ) {
    if (
      !process.env.CAC_PREVIEW_DATABASE_HOST ||
      new URL(process.env.DATABASE_URL).hostname !==
        process.env.CAC_PREVIEW_DATABASE_HOST ||
      process.env.APP_ENV !== "preview"
    )
      throw new Error(
        "La vista previa requiere una rama de datos independiente.",
      );
  }
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 10_000,
  }));
}
export async function transaction<T>(
  fn: (client: import("@neondatabase/serverless").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}
