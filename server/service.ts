import { holidaysBetween } from "./holidays";
import type { PoolClient } from "@neondatabase/serverless";
import type { BookData, Lesson } from "../src/domain";
import { lessonsFor, isRetired } from "../src/domain";
import { randomUUID } from "node:crypto";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = status === 401
      ? "SESSION_EXPIRED"
      : status === 403
        ? "FORBIDDEN"
        : status === 409
          ? "CONFLICT"
          : "INVALID_REQUEST",
    public current?: unknown,
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
  if (!access) throw new HttpError(401, "Tu sesión venció. Vuelve a ingresar.");
  if (
    !access ||
    (access.kind !== "admin" &&
      !(access.kind === "book" && access.book_id === bookId))
  )
    throw new HttpError(403, "Ingresa con la contraseña de este libro.");
}
export function requireAdmin(access: Access | null): asserts access is Access {
  if (!access) throw new HttpError(401, "Tu sesión venció. Vuelve a ingresar.");
  if (access?.kind !== "admin")
    throw new HttpError(403, "Esta acción requiere acceso de administración.");
}
export async function loadBook(
  c: PoolClient,
  bookId: string,
): Promise<BookData> {
  const book = (
    await c.query(
      `SELECT b.archived_at,b.id,b.teacher_id,b.period_id,b.discipline,b.sessions_per_week,b.duration_minutes,t.name AS teacher_name,p.name AS period_name FROM books b JOIN teachers t ON t.id=b.teacher_id JOIN periods p ON p.id=b.period_id WHERE b.id=$1`,
      [bookId],
    )
  ).rows[0];
  if (!book) throw new HttpError(404, "No encontramos ese libro.");
  const period = (
    await c.query(
      "SELECT archived_at,id,name,start_date::text,end_date::text FROM periods WHERE id=$1",
      [book.period_id],
    )
  ).rows[0];
  const enrollments = (
    await c.query(
      "SELECT e.id,e.student_id,e.book_id,s.full_name,e.joined_on::text,e.left_on::text,e.note,e.note_revision FROM enrollments e JOIN students s ON s.id=e.student_id WHERE book_id=$1 ORDER BY s.full_name",
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
      "SELECT l.enrollment_id,l.date::text,l.slot,to_char(l.time,'HH24:MI') AS time,a.status,l.revision FROM lessons l LEFT JOIN attendance a ON a.lesson_id=l.id JOIN enrollments e ON e.id=l.enrollment_id WHERE e.book_id=$1",
      [bookId],
    )
  ).rows;
  const exceptions = new Set<string>(
    (await c.query("SELECT date::text FROM holiday_exceptions")).rows.map(
      (r) => r.date,
    ),
  );
  suspensions.push(
    ...holidaysBetween(period.start_date, period.end_date, exceptions),
  );
  return {
    book,
    period,
    enrollments,
    schedules,
    suspensions,
    attendance,
    can_write: !book.archived_at && !period.archived_at,
  };
}
export function requireWritable(data: BookData) {
  if (data.book.archived_at || data.period.archived_at)
    throw new HttpError(
      409,
      "Este libro está archivado. Administración debe restaurarlo para modificarlo.",
      "ARCHIVED",
    );
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
    expected_revision: number;
    resolve_conflict?: boolean;
  },
) {
  requireBook(access, bookId);
  await lockBook(c, bookId);
  const data = visibleBook(await loadBook(c, bookId), access);
  requireWritable(data);
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
  const currentRevision = lesson.revision || 0;
  if (input.expected_revision !== currentRevision)
    throw new HttpError(
      409,
      "Otra sesión modificó esta asistencia.",
      "REVISION_CONFLICT",
      { revision: currentRevision, status: lesson.underlying || null },
    );
  const row = (
    await c.query(
      "INSERT INTO lessons(id,enrollment_id,date,slot,time,revision) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(enrollment_id,date,slot) DO UPDATE SET time=EXCLUDED.time,revision=lessons.revision+1 RETURNING id,revision",
      [randomUUID(), input.enrollment_id, input.date, input.slot, lesson.time],
    )
  ).rows[0];
  if (input.status)
    await c.query(
      "INSERT INTO attendance(lesson_id,status) VALUES($1,$2) ON CONFLICT(lesson_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()",
      [row.id, input.status],
    );
  else await c.query("DELETE FROM attendance WHERE lesson_id=$1", [row.id]);
  await audit(
    c,
    access,
    input.resolve_conflict ? "attendance.conflict_resolved" : "attendance.set",
    bookId,
    {
      ...input,
      previous: lesson.status,
    },
  );
  return { ok: true, revision: row.revision };
}
export function findLesson(
  data: BookData,
  lesson: Pick<Lesson, "date" | "slot" | "enrollment_id">,
) {
  return lessonsFor(data, lesson.date, lesson.date).find(
    (l) => l.slot === lesson.slot && l.enrollment_id === lesson.enrollment_id,
  );
}

/** Retired students and all records identifying them are visible only to administration. */
export function visibleBook(data: BookData, access: Access): BookData {
  if (access.kind === "admin") return data;
  const enrollments = data.enrollments.filter((e) => !isRetired(e));
  const ids = new Set(enrollments.map((e) => e.id));
  return {
    ...data,
    enrollments,
    schedules: data.schedules.filter((s) => ids.has(s.enrollment_id)),
    attendance: data.attendance.filter((a) => ids.has(a.enrollment_id)),
  };
}

export async function loadAdminBooks(c: PoolClient): Promise<BookData[]> {
  const books = (
    await c.query(
      "SELECT b.archived_at,b.id,b.teacher_id,b.period_id,b.discipline,b.sessions_per_week,b.duration_minutes,t.name AS teacher_name,p.name AS period_name FROM books b JOIN teachers t ON t.id=b.teacher_id JOIN periods p ON p.id=b.period_id ORDER BY t.name,b.discipline",
    )
  ).rows;
  const periods = (
    await c.query(
      "SELECT archived_at,id,name,start_date::text,end_date::text FROM periods",
    )
  ).rows;
  const enrollments = (
    await c.query(
      "SELECT e.id,e.student_id,e.book_id,s.full_name,e.joined_on::text,e.left_on::text,e.note,e.note_revision FROM enrollments e JOIN students s ON s.id=e.student_id ORDER BY s.full_name",
    )
  ).rows;
  const schedules = (
    await c.query(
      "SELECT id,enrollment_id,effective_from::text,slots FROM schedule_versions",
    )
  ).rows;
  const attendance = (
    await c.query(
      "SELECT l.enrollment_id,l.date::text,l.slot,to_char(l.time,'HH24:MI') AS time,a.status,l.revision FROM lessons l LEFT JOIN attendance a ON a.lesson_id=l.id",
    )
  ).rows;
  const suspensions = (
    await c.query(
      "SELECT id,scope,target_id,start_date::text,end_date::text,reason FROM suspensions",
    )
  ).rows;
  const exceptions = new Set<string>(
    (await c.query("SELECT date::text FROM holiday_exceptions")).rows.map(
      (r) => r.date,
    ),
  );
  return books.map((book) => {
    const members = enrollments.filter((e) => e.book_id === book.id);
    const ids = new Set(members.map((e) => e.id));
    return {
      book,
      can_write:
        !book.archived_at &&
        !periods.find((p) => p.id === book.period_id)?.archived_at,
      period: periods.find((p) => p.id === book.period_id),
      enrollments: members,
      schedules: schedules.filter((s) => ids.has(s.enrollment_id)),
      attendance: attendance.filter((a) => ids.has(a.enrollment_id)),
      suspensions: [
        ...holidaysBetween(
          periods.find((p) => p.id === book.period_id).start_date,
          periods.find((p) => p.id === book.period_id).end_date,
          exceptions,
        ),
        ...suspensions.filter(
          (s) =>
            s.scope === "center" ||
            (s.scope === "teacher" && s.target_id === book.teacher_id) ||
            (s.scope === "book" && s.target_id === book.id),
        ),
      ],
    };
  });
}
