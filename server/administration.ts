import { z } from "zod";
import type { PoolClient } from "@neondatabase/serverless";
import { id, name, date } from "./validation";
import {
  audit,
  HttpError,
  loadBook,
  lockBook,
  requireWritable,
  type Access,
} from "./service";
import { scheduleConflict } from "../src/domain";

export async function administer(c: PoolClient, access: Access, raw: any) {
  if (raw.action === "archive") {
    const v = z
      .object({
        entity: z.enum(["teacher", "period", "book"]),
        id,
        archived: z.boolean(),
      })
      .parse(raw);
    const table = { teacher: "teachers", period: "periods", book: "books" }[
      v.entity
    ];
    // Lock affected books first, in the same order as other multi-book operations.
    const books = (
      await c.query(
        `SELECT id FROM books WHERE ${v.entity === "book" ? "id" : v.entity + "_id"}=$1 ORDER BY id FOR UPDATE`,
        [v.id],
      )
    ).rows;
    const row = await c.query(
      `UPDATE ${table} SET archived_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$2 RETURNING id`,
      [v.archived, v.id],
    );
    if (!row.rowCount) throw new HttpError(404, "Registro no encontrado.");
    await audit(
      c,
      access,
      v.archived ? "entity.archive" : "entity.restore",
      v.entity === "book" ? v.id : null,
      { ...v, books: books.map((b) => b.id) },
    );
    return;
  }
  if (raw.action === "edit-teacher") {
    const v = z.object({ id, name }).parse(raw);
    if (
      !(
        await c.query("UPDATE teachers SET name=$1 WHERE id=$2 RETURNING id", [
          v.name,
          v.id,
        ])
      ).rowCount
    )
      throw new HttpError(404, "Profesor no encontrado.");
    await audit(c, access, "teacher.update", null, v);
    return;
  }
  if (raw.action === "edit-period") {
    const v = z
      .object({ id, name, start_date: date, end_date: date })
      .refine(
        (v) =>
          v.start_date <= v.end_date &&
          (Date.parse(v.end_date) - Date.parse(v.start_date)) / 86400000 <= 730,
        "Revisa las fechas del período (máximo dos años).",
      )
      .parse(raw);
    await c.query(
      "SELECT id FROM books WHERE period_id=$1 ORDER BY id FOR UPDATE",
      [v.id],
    );
    const p = (
      await c.query(
        "SELECT id,name,start_date::text,end_date::text,archived_at FROM periods WHERE id=$1 FOR UPDATE",
        [v.id],
      )
    ).rows[0];
    if (!p) throw new HttpError(404, "Período no encontrado.");
    if (
      (v.start_date !== String(p.start_date).slice(0, 10) ||
        v.end_date !== String(p.end_date).slice(0, 10)) &&
      (
        await c.query(
          "SELECT id FROM books WHERE period_id=$1 AND archived_at IS NOT NULL LIMIT 1",
          [v.id],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "Restaura los libros archivados antes de cambiar las fechas del período.",
      );
    if (p.archived_at)
      throw new HttpError(
        409,
        "Restaura el período antes de editarlo.",
        "ARCHIVED",
      );
    const outside = (
      await c.query(
        `SELECT e.id FROM enrollments e JOIN books b ON b.id=e.book_id WHERE b.period_id=$1 AND (e.joined_on<$2 OR e.joined_on>$3 OR e.left_on>$3 OR EXISTS(SELECT 1 FROM schedule_versions s WHERE s.enrollment_id=e.id AND (s.effective_from<$2 OR s.effective_from>$3)) OR EXISTS(SELECT 1 FROM lessons l JOIN attendance a ON a.lesson_id=l.id WHERE l.enrollment_id=e.id AND (l.date<$2 OR l.date>$3))) LIMIT 1`,
        [v.id, v.start_date, v.end_date],
      )
    ).rowCount;
    if (outside)
      throw new HttpError(
        409,
        "Las fechas dejarían matrículas, horarios o asistencias fuera del período.",
      );
    await c.query(
      "UPDATE periods SET name=$1,start_date=$2,end_date=$3 WHERE id=$4",
      [v.name, v.start_date, v.end_date, v.id],
    );
    await audit(c, access, "period.update", null, v);
    return;
  }
  if (raw.action === "edit-book") {
    const v = z.object({ id, discipline: name, teacher_id: id }).parse(raw);
    await lockBook(c, v.id);
    const data = await loadBook(c, v.id);
    requireWritable(data);
    const teacher = (
      await c.query(
        "SELECT id,archived_at FROM teachers WHERE id=$1 FOR SHARE",
        [v.teacher_id],
      )
    ).rows[0];
    if (
      !teacher ||
      (teacher.archived_at && data.book.teacher_id !== v.teacher_id)
    )
      throw new HttpError(409, "Selecciona un profesor activo.");
    await c.query("UPDATE books SET discipline=$1,teacher_id=$2 WHERE id=$3", [
      v.discipline,
      v.teacher_id,
      v.id,
    ]);
    await audit(c, access, "book.update", v.id, v);
    return;
  }
  if (raw.action === "duration") {
    const v = z
      .object({
        book_id: id,
        duration_minutes: z.number().int().min(5).max(480),
      })
      .parse(raw);
    await lockBook(c, v.book_id);
    const data = await loadBook(c, v.book_id);
    requireWritable(data);
    const candidate = {
      ...data,
      book: { ...data.book, duration_minutes: v.duration_minutes },
    };
    for (const student of candidate.enrollments) {
      const conflict = scheduleConflict(candidate, student.id);
      if (conflict)
        throw new HttpError(409, `${student.full_name}: ${conflict.message}`);
    }
    await c.query("UPDATE books SET duration_minutes=$1 WHERE id=$2", [
      v.duration_minutes,
      v.book_id,
    ]);
    await audit(c, access, "book.duration", v.book_id, v);
    return;
  }
  throw new HttpError(400, "Operación administrativa inválida.");
}
