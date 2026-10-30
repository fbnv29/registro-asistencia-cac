import { z } from "zod";
export const id = z.string().uuid();
export const name = z.string().trim().min(1).max(120);
export const password = z
  .string()
  .min(6, "Usa al menos 6 caracteres.")
  .max(128);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T12:00:00Z");
    return !isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, "Fecha inválida.");
export const slot = z.object({
  day: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export const slots = z
  .array(slot)
  .min(1)
  .max(7)
  .refine(
    (v) => new Set(v.map((s) => `${s.day}/${s.time}`)).size === v.length,
    "No repitas el mismo día y hora.",
  );
