import "dotenv/config";
import { transaction, closeDatabase } from "../server/db";
import { hashPassword } from "../server/security";
const admin = process.env.CAC_ADMIN_PASSWORD,
  creator = process.env.CAC_CREATOR_PASSWORD;
if (
  !admin ||
  !creator ||
  admin.length < 6 ||
  admin.length > 128 ||
  creator.length > 128 ||
  creator.length < 6 ||
  admin === creator
)
  throw new Error(
    "Define CAC_ADMIN_PASSWORD y CAC_CREATOR_PASSWORD distintos, con al menos 6 caracteres.",
  );
await transaction(async (c) => {
  for (const [kind, value] of [
    ["admin", admin],
    ["creator", creator],
  ])
    await c.query(
      "INSERT INTO access_keys(kind,password_hash) VALUES($1,$2) ON CONFLICT(kind) DO UPDATE SET password_hash=EXCLUDED.password_hash",
      [kind, await hashPassword(value)],
    );
  await c.query(
    "DELETE FROM access_sessions WHERE kind IN ('admin','creator')",
  );
});
await closeDatabase();
console.log(
  "Contraseñas configuradas. No se muestran ni se guardan en el código.",
);
