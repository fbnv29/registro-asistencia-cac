import "dotenv/config";
import { transaction, closeDatabase } from "../server/db";
import { hashPassword } from "../server/security";
const admin = process.env.CAC_ADMIN_PASSWORD;
if (!admin || admin.length < 6 || admin.length > 128)
  throw new Error("Define CAC_ADMIN_PASSWORD con entre 6 y 128 caracteres.");
await transaction(async (c) => {
  await c.query(
    "INSERT INTO access_keys(kind,password_hash) VALUES($1,$2) ON CONFLICT(kind) DO UPDATE SET password_hash=EXCLUDED.password_hash",
    ["admin", await hashPassword(admin)],
  );
  await c.query(
    "DELETE FROM access_sessions WHERE kind IN ('admin','creator')",
  );
});
await closeDatabase();
console.log(
  "Contraseña administrativa configurada. La creación de libros requiere acceso administrativo.",
);
