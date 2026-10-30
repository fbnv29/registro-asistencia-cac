import { randomUUID } from "node:crypto";
import type { PoolClient } from "@neondatabase/serverless";
import { z } from "zod";
import { id, name, date, slots, password } from "./validation";
import { applyBookChange, createBook } from "./changes";
import {
  audit,
  HttpError,
  loadBook,
  lockBook,
  requireBook,
  requireAdmin,
  visibleBook,
  type Access,
} from "./service";
import { digest, hashPassword } from "./security";
import type { BookData } from "../src/domain";
export type ChangeKind =
  "student.create" | "student.update" | "schedule.update" | "book.create";
const administrator: Access = { kind: "admin", book_id: null };
const studentSchema = z.object({
  enrollment_id: id.optional(),
  full_name: name,
  joined_on: date,
  left_on: date.nullable().optional(),
  slots: slots.optional(),
});
const scheduleSchema = z.object({
  enrollment_id: id,
  effective_from: date,
  slots,
});
const bookSchema = z.object({
  teacher_id: id,
  period_id: id,
  discipline: name,
  sessions_per_week: z.number().int().min(1).max(7),
  password,
});
function baseline(data: BookData, payload: any) {
  const enrollment = payload.enrollment_id
    ? data.enrollments.find((e) => e.id === payload.enrollment_id)
    : null;
  if (payload.enrollment_id && !enrollment)
    throw new HttpError(404, "Estudiante no encontrado en este libro.");
  return {
    book: {
      teacher_id: data.book.teacher_id,
      period_id: data.book.period_id,
      sessions_per_week: data.book.sessions_per_week,
    },
    period: data.period,
    ...(enrollment
      ? {
          enrollment,
          schedules: data.schedules
            .filter((s) => s.enrollment_id === enrollment.id)
            .sort((a, b) => a.effective_from.localeCompare(b.effective_from)),
        }
      : {}),
  };
}
async function validateWithoutApplying(
  c: PoolClient,
  bookId: string,
  kind: ChangeKind,
  payload: unknown,
) {
  await c.query("SAVEPOINT validate_proposal");
  try {
    if (kind === "book.create")
      await createBook(c, administrator, payload, true);
    else
      await applyBookChange(
        c,
        administrator,
        bookId,
        kind === "schedule.update" ? "schedule" : "students",
        payload,
      );
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT validate_proposal");
    await c.query("RELEASE SAVEPOINT validate_proposal");
  }
}
export async function proposeChange(
  c: PoolClient,
  access: Access,
  bookId: string,
  kind: ChangeKind,
  raw: unknown,
) {
  requireBook(access, bookId);
  await lockBook(c, bookId);
  const data = visibleBook(await loadBook(c, bookId), access);
  let payload: any;
  if (kind === "book.create") {
    const parsed = bookSchema.parse(raw);
    if (parsed.teacher_id !== data.book.teacher_id)
      throw new HttpError(
        403,
        "Solo puedes proponer un libro para el profesor asociado a tu libro.",
      );
    const { password: secret, ...fields } = parsed;
    payload = { ...fields, password_hash: await hashPassword(secret) };
  } else if (kind === "schedule.update") payload = scheduleSchema.parse(raw);
  else {
    payload = studentSchema.parse(raw);
    if ((kind === "student.update") !== !!payload.enrollment_id)
      throw new HttpError(400, "Revisa el tipo de modificación.");
  }
  const base = baseline(data, payload);
  if (kind === "student.update" && payload.left_on === undefined)
    payload.left_on = base.enrollment?.left_on || null;
  await validateWithoutApplying(c, bookId, kind, payload);
  const signature = { ...payload };
  delete signature.password_hash;
  const hash = digest(JSON.stringify(signature));
  const row = (
    await c.query(
      `INSERT INTO change_requests(id,book_id,kind,payload,payload_hash,base_state) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(book_id,kind,payload_hash) WHERE status='pending' DO UPDATE SET payload_hash=EXCLUDED.payload_hash RETURNING id,status`,
      [
        randomUUID(),
        bookId,
        kind,
        JSON.stringify(payload),
        hash,
        JSON.stringify(base),
      ],
    )
  ).rows[0];
  await audit(c, access, "request.submit", bookId, {
    request_id: row.id,
    kind,
  });
  return {
    ...row,
    pending: true,
    message:
      "Solicitud enviada. El libro cambiará cuando administración la apruebe.",
  };
}
export async function listRequests(
  c: PoolClient,
  access: Access,
  bookId?: string,
) {
  if (bookId) requireBook(access, bookId);
  else requireAdmin(access);
  const result = (
    await c.query(
      `SELECT r.id,r.book_id,r.kind,r.payload-'password_hash' AS payload,r.base_state,r.status,r.submitted_at,r.reviewed_at,r.review_note,r.result,b.discipline,t.name AS teacher_name FROM change_requests r JOIN books b ON b.id=r.book_id JOIN teachers t ON t.id=b.teacher_id ${bookId ? "WHERE r.book_id=$1" : ""} ORDER BY (r.status='pending') DESC,r.submitted_at DESC`,
      bookId ? [bookId] : [],
    )
  ).rows;
  if (access.kind === "admin" || !bookId) return result;
  const data = visibleBook(await loadBook(c, bookId), access);
  return result.map((row) =>
    row.payload.enrollment_id &&
    !data.enrollments.some((e) => e.id === row.payload.enrollment_id)
      ? {
          ...row,
          payload: { full_name: "Estudiante retirado" },
          base_state: null,
        }
      : row,
  );
}
export async function reviewRequest(
  c: PoolClient,
  access: Access,
  requestId: string,
  input: { decision: "approve" | "reject"; note: string },
) {
  requireAdmin(access);
  const pointer = (
    await c.query("SELECT book_id FROM change_requests WHERE id=$1", [
      requestId,
    ])
  ).rows[0];
  if (!pointer) throw new HttpError(404, "Solicitud no encontrada.");
  await lockBook(c, pointer.book_id);
  const request = (
    await c.query("SELECT * FROM change_requests WHERE id=$1 FOR UPDATE", [
      requestId,
    ])
  ).rows[0];
  if (request.status !== "pending")
    throw new HttpError(
      409,
      "Esta solicitud ya fue revisada. Actualiza la bandeja.",
    );
  let result: unknown = null;
  if (input.decision === "approve") {
    const data = await loadBook(c, request.book_id);
    const current = baseline(data, request.payload);
    // PostgreSQL jsonb does not preserve object-key order, so compare values, not JSON strings.
    const matches = (
      await c.query("SELECT $1::jsonb = $2::jsonb AS same", [
        JSON.stringify(current),
        JSON.stringify(request.base_state),
      ])
    ).rows[0].same;
    if (!matches)
      throw new HttpError(
        409,
        "El libro o el estudiante cambió desde que se envió esta solicitud. Recházala con una observación y solicita una propuesta actualizada.",
      );
    result =
      request.kind === "book.create"
        ? await createBook(c, access, request.payload, true)
        : await applyBookChange(
            c,
            access,
            request.book_id,
            request.kind === "schedule.update" ? "schedule" : "students",
            request.payload,
          );
  }
  const status = input.decision === "approve" ? "approved" : "rejected";
  await c.query(
    "UPDATE change_requests SET status=$1,reviewed_at=now(),review_note=$2,result=$3 WHERE id=$4",
    [status, input.note, JSON.stringify(result), requestId],
  );
  await audit(c, access, `request.${status}`, request.book_id, {
    request_id: requestId,
    kind: request.kind,
    note: input.note,
    result,
  });
  return { id: requestId, status, result };
}
