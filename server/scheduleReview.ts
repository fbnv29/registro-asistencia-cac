import { z } from "zod";
import type { PoolClient } from "@neondatabase/serverless";
import { date, id, slots } from "./validation";
import { digest } from "./security";
import {
  HttpError,
  loadBook,
  lockBook,
  requireBook,
  requireWritable,
  visibleBook,
  type Access,
} from "./service";
import { scheduleConflict, type BookData } from "../src/domain";
import {
  reviewSchedule,
  lessonKey,
  type ScheduleInput,
} from "../src/scheduleReview";

export const scheduleSchema = z.object({
  enrollment_id: id,
  effective_from: date,
  slots,
  review_token: z.string().optional(),
  transfers: z
    .array(
      z.object({
        from_date: date,
        from_slot: z.number().int().min(0).max(6),
        to_date: date,
        to_slot: z.number().int().min(0).max(6),
      }),
    )
    .max(3000)
    .default([]),
});
// Stable across PostgreSQL jsonb serialization (which reorders object keys).
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function buildSchedulePreview(data: BookData, input: ScheduleInput) {
  const e = data.enrollments.find((e) => e.id === input.enrollment_id);
  if (!e) throw new HttpError(404, "Estudiante no encontrado.");
  if (
    input.slots.length !== data.book.sessions_per_week ||
    input.effective_from < e.joined_on ||
    input.effective_from < data.period.start_date ||
    input.effective_from > (e.left_on || data.period.end_date) ||
    input.effective_from > data.period.end_date
  )
    throw new HttpError(
      400,
      "Revisa la fecha y la cantidad de sesiones del horario.",
    );
  const { candidate, ...preview } = reviewSchedule(data, input);
  const unchanged = canonical(preview.previous) === canonical(preview.proposed);
  const conflict = unchanged
    ? null
    : scheduleConflict(candidate, e.id, preview.from, preview.to);
  if (conflict) throw new HttpError(409, conflict.message);
  const attendance = data.attendance
    .filter(
      (a) =>
        a.enrollment_id === e.id &&
        a.date >= preview.from &&
        a.date <= preview.to,
    )
    .sort((a, b) => lessonKey(a).localeCompare(lessonKey(b)));
  const review_token = digest(
    canonical({
      input: {
        enrollment_id: input.enrollment_id,
        effective_from: input.effective_from,
        slots: input.slots,
      },
      enrollment: { joined_on: e.joined_on, left_on: e.left_on },
      period: data.period,
      book: data.book,
      schedules: data.schedules
        .filter((s) => s.enrollment_id === e.id)
        .sort((a, b) => a.effective_from.localeCompare(b.effective_from)),
      attendance,
      suspensions: [...data.suspensions].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      preview,
    }),
  );
  return { ...preview, review_token };
}
export async function previewSchedule(
  c: PoolClient,
  access: Access,
  bookId: string,
  raw: unknown,
) {
  requireBook(access, bookId);
  await c.query("SELECT pg_advisory_xact_lock(483723)");
  await lockBook(c, bookId);
  const data = visibleBook(await loadBook(c, bookId), access);
  requireWritable(data);
  return buildSchedulePreview(data, scheduleSchema.parse(raw));
}
export function validateTransfers(
  preview: ReturnType<typeof buildSchedulePreview>,
  input: z.infer<typeof scheduleSchema>,
) {
  if (
    (input.review_token && input.review_token !== preview.review_token) ||
    (preview.affected.length && !input.review_token)
  )
    throw new HttpError(
      409,
      "El horario o las asistencias cambiaron. Vuelve a revisar el cambio antes de guardarlo.",
      "SCHEDULE_REVIEW_REQUIRED",
    );
  const sources = new Set<string>(),
    destinations = new Set<string>();
  for (const t of input.transfers) {
    const source = `${t.from_date}/${t.from_slot}`,
      dest = `${t.to_date}/${t.to_slot}`;
    if (
      sources.has(source) ||
      destinations.has(dest) ||
      !preview.affected.some((l) => lessonKey(l) === source) ||
      !preview.destinations.some((l) => lessonKey(l) === dest)
    )
      throw new HttpError(
        409,
        "Cada asistencia debe tener un destino disponible y distinto. Revisa las correspondencias.",
        "SCHEDULE_REVIEW_REQUIRED",
      );
    sources.add(source);
    destinations.add(dest);
  }
  if (sources.size !== preview.affected.length)
    throw new HttpError(
      409,
      "Relaciona todas las asistencias afectadas antes de guardar el horario.",
      "SCHEDULE_REVIEW_REQUIRED",
    );
}
