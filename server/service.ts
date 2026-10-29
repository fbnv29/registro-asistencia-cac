import type { PoolClient } from "@neondatabase/serverless";
import type { BookData, Lesson } from "../src/domain";
import { lessonsFor } from "../src/domain";
import { randomUUID } from "node:crypto";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Access {
  kind: "admin" | "creator" | "book";
  book_id: string | null;
}
export async function audit(
  c: PoolClient,
  access: Access,
  action: string,
  bookId: string | null,
  details: unknown,
) {
  await c.query(
    "INSERT INTO audit_log(access_kind,action,book_id,details) VALUES($1,$2,$3,$4)",
    [access.kind, action, bookId, JSON.stringify(details)],
  );
}
export function requireBook(access: Access | null, bookId: string) {
  if (
    !access ||
    (access.kind !== "admin" &&
      !(access.kind === "book" && access.book_id === bookId))
  )
    throw new HttpError(403, "Ingresa con la contraseña de este libro.");
}
export function requireAdmin(access: Access | null): asserts access is Access {
  if (access?.kind !== "admin")
    throw new HttpError(403, "Esta acción requiere acceso de administración.");
}
export async function loadBook(
  c: PoolClient,
  bookId: string,
): Promise<BookData> {
  const book = (
    await c.query(
      `SELECT b.id,b.teacher_id,b.period_id,b.discipline,b.sessions_per_week,b.duration_minutes,t.name AS teacher_name,p.name AS period_name FROM books b JOIN teachers t ON t.id=b.teacher_id JOIN periods p ON p.id=b.period_id WHERE b.id=$1`,
      [bookId],
    )
  ).rows[0];
  if (!book) throw new HttpError(404, "No encontramos ese libro.");
  const period = (
    await c.query(
      "SELECT id,name,start_date::text,end_date::text FROM periods WHERE id=$1",
      [book.period_id],
    )
  ).rows[0];
  const enrollments = (
    await c.query(
      "SELECT e.id,e.student_id,e.book_id,s.full_name,e.joined_on::text,e.left_on::text FROM enrollments e JOIN students s ON s.id=e.student_id WHERE book_id=$1 ORDER BY s.full_name",
      [bookId],
    )
  ).rows;
  const schedules = (
    await c.query(
      "SELECT v.id,v.enrollment_id,v.effective_from::text,v.slots FROM schedule_versions v JOIN enrollments e ON e.id=v.enrollment_id WHERE e.book_id=$1 ORDER BY v.effective_from",
      [bookId],
    )
  ).rows;
  const suspensions = (
    await c.query(
      "SELECT id,scope,target_id,start_date::text,end_date::text,reason FROM suspensions WHERE scope='center' OR (scope='teacher' AND target_id=$1) OR (scope='book' AND target_id=$2)",
      [book.teacher_id, bookId],
    )
  ).rows;
  const attendance = (
    await c.query(
      "SELECT l.enrollment_id,l.date::text,l.slot,a.status FROM attendance a JOIN lessons l ON l.id=a.lesson_id JOIN enrollments e ON e.id=l.enrollment_id WHERE e.book_id=$1",
      [bookId],
    )
  ).rows;
  return { book, period, enrollments, schedules, suspensions, attendance };
}
export async function lockBook(c: PoolClient, id: string) {
  if (
    !(await c.query("SELECT id FROM books WHERE id=$1 FOR UPDATE", [id]))
      .rowCount
  )
    throw new HttpError(404, "No encontramos ese libro.");
}
export async function setAttendance(
  c: PoolClient,
  access: Access,
  bookId: string,
  input: {
    enrollment_id: string;
    date: string;
    slot: number;
    status: string | null;
  },
) {
  requireBook(access, bookId);
  await lockBook(c, bookId);
  const data = await loadBook(c, bookId);
  const lesson = lessonsFor(data, input.date, input.date).find(
    (l) => l.enrollment_id === input.enrollment_id && l.slot === input.slot,
  );
  if (!lesson)
    throw new HttpError(
      409,
      "La sesión no pertenece al horario vigente. Actualiza el libro.",
    );
  if (lesson.status === "suspended")
    throw new HttpError(409, "Esta sesión está suspendida por administración.");
  const row = (
    await c.query(
      "INSERT INTO lessons(id,enrollment_id,date,slot,time) VALUES($1,$2,$3,$4,$5) ON CONFLICT(enrollment_id,date,slot) DO UPDATE SET time=EXCLUDED.time RETURNING id",
      [randomUUID(), input.enrollment_id, input.date, input.slot, lesson.time],
    )
  ).rows[0];
  if (input.status)
    await c.query(
      "INSERT INTO attendance(lesson_id,status) VALUES($1,$2) ON CONFLICT(lesson_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()",
      [row.id, input.status],
    );
  else await c.query("DELETE FROM attendance WHERE lesson_id=$1", [row.id]);
  await audit(c, access, "attendance.set", bookId, {
    ...input,
    previous: lesson.status,
  });
}
export function findLesson(
  data: BookData,
  lesson: Pick<Lesson, "date" | "slot" | "enrollment_id">,
) {
  return lessonsFor(data, lesson.date, lesson.date).find(
    (l) => l.slot === lesson.slot && l.enrollment_id === lesson.enrollment_id,
  );
}
