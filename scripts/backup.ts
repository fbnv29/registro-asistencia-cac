import { existsSync } from "node:fs";
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdir, chmod, access, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const source = process.env.DATABASE_URL_UNPOOLED;
if (!source) throw new Error("Configura DATABASE_URL_UNPOOLED.");
function direct(value: string) {
  const u = new URL(value);
  if (u.hostname.includes("-pooler"))
    throw new Error("Usa una conexión directa.");
  return u;
}
const sourceUrl = direct(source);
const mode = process.argv[2] || "backup";
const file = resolve(
  process.argv[3] ||
    `artifacts/backups/cac-${new Date().toISOString().replaceAll(":", "-")}.dump`,
);
const bin =
  process.env.PG_BIN ||
  (existsSync("/opt/homebrew/opt/libpq/bin/pg_dump")
    ? "/opt/homebrew/opt/libpq/bin"
    : "");
function run(command: string, args: string[], connection: string) {
  const u = direct(connection);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin ? `${bin}/${command}` : command, args, {
      env: {
        ...process.env,
        PGHOST: u.hostname,
        PGPORT: u.port || "5432",
        PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
        PGSSLMODE: "require",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Tool stderr may contain connection details; expose only command and exit status.
    child.stderr.resume();
    child.on("error", () =>
      reject(
        new Error(
          `No se pudo ejecutar ${command}. Configura PG_BIN con las utilidades PostgreSQL.`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} falló (${code}). No se muestran credenciales.`,
            ),
          ),
    );
  });
}
process.umask(0o077);
if (mode === "backup") {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await access(file);
    throw new Error("El archivo ya existe; elige otro destino.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await run(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl", "--file", file],
      source,
    );
    await chmod(file, 0o600);
  } catch (e) {
    await unlink(file).catch(() => {});
    throw e;
  }
  console.log(`Respaldo creado: ${file}`);
} else if (mode === "restore") {
  const target = process.env.CAC_RESTORE_DATABASE_URL;
  if (
    !target ||
    !["development", "preview"].includes(process.env.APP_ENV || "")
  )
    throw new Error(
      "La restauración requiere APP_ENV de desarrollo y CAC_RESTORE_DATABASE_URL.",
    );
  const t = direct(target);
  if (
    !/^cac_restore_check_[a-z0-9_]+$/.test(t.pathname.slice(1)) ||
    t.hostname !== sourceUrl.hostname ||
    t.pathname === sourceUrl.pathname
  )
    throw new Error(
      "Solo se restaura en una base temporal cac_restore_check_* distinta, en el mismo servidor de desarrollo.",
    );
  await run(
    "pg_restore",
    [
      "--dbname",
      t.pathname.slice(1),
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      file,
    ],
    target,
  );
  console.log("Restauración terminada en la base temporal de desarrollo.");
} else throw new Error("Usa backup o restore.");
