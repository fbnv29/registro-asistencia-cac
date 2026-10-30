import { expect, it, vi } from "vitest";
import { administer } from "../server/administration";
import { confirmPermanentDelete } from "../src/permanentDelete";

const recordId = "11111111-1111-4111-8111-111111111111";
const input = {
  action: "delete-permanently",
  entity: "teacher",
  id: recordId,
  confirmed: true,
  confirmation: "ELIMINAR",
};

it("requires both confirmations before deletion", () => {
  const confirm = vi.fn().mockReturnValue(false);
  const prompt = vi.fn().mockReturnValue("ELIMINAR");
  vi.stubGlobal("window", { confirm, prompt });
  try {
    expect(confirmPermanentDelete("Profesor", "Se eliminará su ficha.")).toBe(
      false,
    );
    expect(prompt).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    prompt.mockReturnValue(null);
    expect(confirmPermanentDelete("Profesor", "")).toBe(false);
    prompt.mockReturnValue("ELIMINAR");
    expect(confirmPermanentDelete("Profesor", "")).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects non-admin access before any database query", async () => {
  const query = vi.fn();
  await expect(
    administer({ query } as any, { kind: "book" } as any, input),
  ).rejects.toThrow("Solo administración");
  expect(query).not.toHaveBeenCalled();
});

it("rejects missing confirmation before any database query", async () => {
  const query = vi.fn();
  await expect(
    administer({ query } as any, { kind: "admin" } as any, {
      ...input,
      confirmation: "",
    }),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

it("protects professors with assigned books from deletion", async () => {
  const query = vi
    .fn()
    .mockResolvedValue({ rowCount: 1, rows: [{ id: recordId }] });
  await expect(
    administer({ query } as any, { kind: "admin" } as any, input),
  ).rejects.toThrow("Reasigna o elimina");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
    false,
  );
});
