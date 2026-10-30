import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "@neondatabase/serverless";
import { id, name, date, slots, password } from "./validation";
import {
  audit,
  HttpError,
  loadBook,
  lockBook,
  visibleBook,
  requireAdmin,
  type Access,
} from "./service";
import { lessonsFor } from "../src/domain";
import { hashPassword } from "./security";
export async function applyBookChange(
  c: PoolClient,
  access: Access,
  bookId: string,
  action: "students" | "schedule",
  raw: unknown,
) {
  requireAdmin(access);
  if (action === "students") {
    const input = z
      .object({
        enrollment_id: id.optional(),
        student_id: id.optional(),
        full_name: name,
        joined_on: date,
        left_on: date.nullable().optional(),
        slots: slots.optional(),
      })
      .parse(raw);
    if (access!.kind !== "admin" && input.left_on != null) requireAdmin(access);
    await lockBook(c, bookId);
    const data = visibleBook(await loadBook(c, bookId), access!);
    if (
      input.joined_on < data.period.start_date ||
      input.joined_on > data.period.end_date ||
      (input.left_on &&
        (input.left_on < input.joined_on ||
          input.left_on > data.period.end_date))
    )
      throw new HttpError(
        400,
        "Las fechas de matrícula deben estar dentro del período y en orden.",
      );
    if (input.enrollment_id) {
      const e = data.enrollments.find((e) => e.id === input.enrollment_id);
      if (!e) throw new HttpError(404, "Estudiante no encontrado.");
      if (input.joined_on !== e.joined_on)
        throw new HttpError(
          400,
          "La fecha de ingreso se conserva para proteger el historial.",
        );
      await c.query("UPDATE students SET full_name=$1 WHERE id=$2", [
        input.full_name,
        e.student_id,
      ]);
      if (access!.kind === "admin" && input.left_on !== undefined)
        await c.query("UPDATE enrollments SET left_on=$1 WHERE id=$2", [
          input.left_on,
          e.id,
        ]);
      await audit(c, access!, "enrollment.update", bookId, {
        enrollment_id: e.id,
        full_name: input.full_name,
        left_on:
          access!.kind === "admin" && input.left_on !== undefined
            ? input.left_on
            : e.left_on,
      });
      return { id: e.id };
    }
    if (!input.slots || input.slots.length !== data.book.sessions_per_week)
      throw new HttpError(
        400,
        "Completa el horario de todas las sesiones semanales.",
      );
    let studentId = input.student_id;
    if (studentId) {
      // Only admin may reuse records across books. Book access may reuse its own existing student IDs.
      if (
        access!.kind !== "admin" &&
        !data.enrollments.some((e) => e.student_id === studentId)
      )
        throw new HttpError(403, "No tienes acceso a esa ficha de estudiante.");
      if (
        !(await c.query("SELECT id FROM students WHERE id=$1", [studentId]))
          .rowCount
      )
        throw new HttpError(404, "Estudiante no encontrado.");
    } else {
      studentId = randomUUID();
      await c.query("INSERT INTO students(id,full_name) VALUES($1,$2)", [
        studentId,
        input.full_name,
      ]);
    }
    const enrollmentId = randomUUID();
    await c.query(
      "INSERT INTO enrollments(id,student_id,book_id,joined_on,left_on) VALUES($1,$2,$3,$4,$5)",
      [enrollmentId, studentId, bookId, input.joined_on, input.left_on || null],
    );
    await c.query(
      "INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,$3,$4)",
      [
        randomUUID(),
        enrollmentId,
        input.joined_on,
        JSON.stringify(input.slots),
      ],
    );
    await audit(c, access!, "enrollment.create", bookId, {
      enrollment_id: enrollmentId,
      student_id: studentId,
    });
    return { id: enrollmentId };
  }
  if (action === "schedule") {
    const input = z
      .object({ enrollment_id: id, effective_from: date, slots })
      .parse(raw);
    await lockBook(c, bookId);
    const data = visibleBook(await loadBook(c, bookId), access!);
    const e = data.enrollments.find((e) => e.id === input.enrollment_id);
    if (!e) throw new HttpError(404, "Estudiante no encontrado.");
    if (
      input.slots.length !== data.book.sessions_per_week ||
      input.effective_from < e.joined_on ||
      input.effective_from > (e.left_on || data.period.end_date)
    )
      throw new HttpError(
        400,
        "Revisa la fecha y la cantidad de sesiones del horario.",
      );
    // Do not silently orphan attendance already entered after the effective date.
    const candidate = {
      ...data,
      schedules: [
        ...data.schedules.filter(
          (s) =>
            !(
              s.enrollment_id === e.id &&
              s.effective_from === input.effective_from
            ),
        ),
        { id: randomUUID(), ...input },
      ],
    };
    const proposed = lessonsFor(candidate, input.effective_from);
    if (
      data.attendance.some(
        (a) =>
          a.enrollment_id === e.id &&
          a.date >= input.effective_from &&
          !proposed.some(
            (l) =>
              l.enrollment_id === e.id &&
              l.date === a.date &&
              l.slot === a.slot,
          ),
      )
    )
      throw new HttpError(
        409,
        "Hay asistencias registradas que quedarían fuera del nuevo horario. Usa una fecha posterior o deja esas marcas pendientes antes de cambiarlo.",
      );
    await c.query(
      "INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,$3,$4) ON CONFLICT(enrollment_id,effective_from) DO UPDATE SET slots=EXCLUDED.slots",
      [randomUUID(), e.id, input.effective_from, JSON.stringify(input.slots)],
    );
    await audit(c, access!, "schedule.set", bookId, input);
    return { ok: true };
  }

  throw new HttpError(400, "Cambio no válido.");
}
export async function createBook(
  c: PoolClient,
  access: Access,
  raw: unknown,
  hashed = false,
) {
  requireAdmin(access);
  const input = z
    .object({
      teacher_id: id,
      period_id: id,
      discipline: name,
      sessions_per_week: z.number().int().min(1).max(7),
      ...(hashed
        ? { password_hash: z.string().startsWith("scrypt:") }
        : { password }),
    })
    .parse(raw);
  const bookId = randomUUID();
  await c.query(
    "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
    [
      bookId,
      input.teacher_id,
      input.period_id,
      input.discipline,
      input.sessions_per_week,
      "password_hash" in input
        ? input.password_hash
        : await hashPassword(input.password),
    ],
  );
  await audit(c, access, "book.create", bookId, {
    teacher_id: input.teacher_id,
    discipline: input.discipline,
  });
  return { id: bookId };
}
