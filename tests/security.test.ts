import { expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  digest,
  newToken,
} from "../server/security";
import { handleApi } from "../server/api";
it("usa hashes salados y valida contraseñas sin exponerlas", async () => {
  const first = await hashPassword("ejemplo-seguro"),
    second = await hashPassword("ejemplo-seguro");
  expect(first).not.toBe(second);
  expect(await verifyPassword("ejemplo-seguro", first)).toBe(true);
  expect(await verifyPassword("otra", first)).toBe(false);
  expect(await verifyPassword("otra", "invalid")).toBe(false);
});
it("genera tokens aleatorios y almacena solo su resumen", () => {
  const token = newToken();
  expect(token).not.toBe(newToken());
  expect(digest(token)).toHaveLength(64);
  expect(digest(token)).not.toContain(token);
});
it("rechaza solicitudes de otro origen antes de acceder a datos", async () => {
  const response = await handleApi(
    new Request("https://cac.example/api/admin", {
      method: "POST",
      headers: {
        Origin: "https://otro.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(response.status).toBe(403);
});
it("rechaza métodos no admitidos", async () => {
  expect(
    (
      await handleApi(
        new Request("https://cac.example/api/catalog", { method: "DELETE" }),
      )
    ).status,
  ).toBe(405);
});
