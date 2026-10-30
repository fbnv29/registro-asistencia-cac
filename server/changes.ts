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
  requireWritable,
  type Access,
} from "./service";
import { addDays, lessonsFor, scheduleConflict } from "../src/domain";
import {
  buildSchedulePreview,
  scheduleSchema,
  validateTransfers,
} from "./scheduleReview";
import { lessonKey } from "../src/scheduleReview";
import { hashPassword } from "./security";
export async function applyBookChange(
  c: PoolClient,
  access: Access,
  bookId: string,
  action: "students" | "schedule",
  raw: unknown,
) {
  requireAdmin(access);
  await c.query("SELECT pg_advisory_xact_lock(483723)");
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
    requireWritable(data);
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
      if (
        e.left_on &&
        (input.left_on === null || (input.left_on && input.left_on > e.left_on))
      ) {
        const candidate = {
          ...data,
          enrollments: data.enrollments.map((row) =>
            row.id === e.id ? { ...row, left_on: input.left_on || null } : row,
          ),
        };
        const conflict = scheduleConflict(
          candidate,
          e.id,
          addDays(e.left_on, 1),
        );
        if (conflict) throw new HttpError(409, conflict.message);
      }
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
    const proposedEnrollmentId = randomUUID();
    const conflict = scheduleConflict(
      {
        ...data,
        enrollments: [
          ...data.enrollments,
          {
            id: proposedEnrollmentId,
            student_id: "new",
            book_id: bookId,
            full_name: input.full_name,
            joined_on: input.joined_on,
            left_on: input.left_on || null,
          },
        ],
        schedules: [
          ...data.schedules,
          {
            id: "proposed",
            enrollment_id: proposedEnrollmentId,
            effective_from: input.joined_on,
            slots: input.slots,
          },
        ],
      },
      proposedEnrollmentId,
    );
    if (conflict) throw new HttpError(409, conflict.message);
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
    const input = scheduleSchema.parse(raw);
    await lockBook(c, bookId);
    const data = visibleBook(await loadBook(c, bookId), access!);
    requireWritable(data);
    const preview = buildSchedulePreview(data, input);
    validateTransfers(preview, input);
    if (
      !preview.affected.length &&
      preview.previous.length === preview.proposed.length &&
      preview.previous.every(
        (s, i) =>
          s.day === preview.proposed[i].day &&
          s.time === preview.proposed[i].time,
      )
    )
      return { ok: true };
    const e = data.enrollments.find((e) => e.id === input.enrollment_id)!;
    const transfers = input.transfers.map((t) => ({
      source: preview.affected.find(
        (l) => lessonKey(l) === `${t.from_date}/${t.from_slot}`,
      )!,
      destination: preview.destinations.find(
        (l) => lessonKey(l) === `${t.to_date}/${t.to_slot}`,
      )!,
    }));
    // Clear all sources first so swaps and slot reorderings cannot overwrite marks.
    for (const { source } of transfers) {
      await c.query(
        "DELETE FROM attendance WHERE lesson_id IN (SELECT id FROM lessons WHERE enrollment_id=$1 AND date=$2 AND slot=$3)",
        [e.id, source.date, source.slot],
      );
      await c.query(
        "UPDATE lessons SET revision=revision+1 WHERE enrollment_id=$1 AND date=$2 AND slot=$3",
        [e.id, source.date, source.slot],
      );
    }
    await c.query(
      "INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,$3,$4) ON CONFLICT(enrollment_id,effective_from) DO UPDATE SET slots=EXCLUDED.slots",
      [randomUUID(), e.id, input.effective_from, JSON.stringify(input.slots)],
    );
    for (const { source, destination } of transfers) {
      const row = (
        await c.query(
          "INSERT INTO lessons(id,enrollment_id,date,slot,time,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(enrollment_id,date,slot) DO UPDATE SET time=EXCLUDED.time,revision=GREATEST(lessons.revision,EXCLUDED.revision)+1 RETURNING id",
          [
            randomUUID(),
            e.id,
            destination.date,
            destination.slot,
            destination.time,
            (source.revision || 0) + 1,
          ],
        )
      ).rows[0];
      await c.query("INSERT INTO attendance(lesson_id,status) VALUES($1,$2)", [
        row.id,
        source.underlying || source.status,
      ]);
    }
    await audit(c, access!, "schedule.set", bookId, {
      ...input,
      transfers: transfers.map(({ source, destination }) => ({
        from: {
          date: source.date,
          slot: source.slot,
          time: source.time,
          revision: source.revision,
        },
        to: {
          date: destination.date,
          slot: destination.slot,
          time: destination.time,
        },
        status: source.underlying || source.status,
      })),
    });
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
  const target = (
    await c.query(
      "SELECT t.archived_at AS teacher_archived,p.archived_at AS period_archived FROM teachers t CROSS JOIN periods p WHERE t.id=$1 AND p.id=$2 FOR SHARE",
      [input.teacher_id, input.period_id],
    )
  ).rows[0];
  if (!target || target.teacher_archived || target.period_archived)
    throw new HttpError(409, "Selecciona un profesor y período activos.");
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
