import "dotenv/config";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { database, closeDatabase } from "../server/db";

it.skipIf(process.env.RUN_INTEGRATION !== "true")(
  "reproduce y corrige el falso cruce histórico sin modificar datos existentes",
  async () => {
    if (!["development", "preview"].includes(process.env.APP_ENV || ""))
      throw new Error("Solo desarrollo o preview.");
    const c = await database().connect();
    const schema = `cac_guard_test_${randomUUID().replaceAll("-", "")}`;
    const [
      teacher,
      period,
      book,
      otherBook,
      student,
      otherStudent,
      enrollment,
      otherEnrollment,
    ] = Array.from({ length: 8 }, () => randomUUID());
    try {
      await c.query("BEGIN");
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET LOCAL search_path TO ${schema}, public`);
      for (const table of [
        "students",
        "periods",
        "books",
        "enrollments",
        "schedule_versions",
      ])
        await c.query(
          `CREATE TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`,
        );
      await c.query(
        "INSERT INTO students(id,full_name) VALUES($1,'Catalina de prueba'),($2,'Otro alumno')",
        [student, otherStudent],
      );
      await c.query(
        "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Prueba','2026-03-01','2026-11-30')",
        [period],
      );
      await c.query(
        "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,duration_minutes) VALUES($1,$3,$4,'Teclado',1,30),($2,$3,$4,'Otro libro',1,45)",
        [book, otherBook, teacher, period],
      );
      await c.query(
        "INSERT INTO enrollments(id,student_id,book_id,joined_on) VALUES($1,$3,$5,'2026-03-01'),($2,$4,$6,'2026-03-01')",
        [enrollment, otherEnrollment, student, otherStudent, book, otherBook],
      );
      await c.query(
        `INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$3,'2026-03-01','[{"day":2,"time":"15:00"}]'),($2,$4,'2026-03-01','[{"day":2,"time":"15:00"}]')`,
        [randomUUID(), randomUUID(), enrollment, otherEnrollment],
      );
      await c.query(
        await readFile("migrations/006_schedule_integrity.sql", "utf8"),
      );
      const move = (time: string, from = "2026-10-30") =>
        c.query(
          "INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,$3,$4)",
          [randomUUID(), enrollment, from, JSON.stringify([{ day: 2, time }])],
        );
      await c.query("SAVEPOINT old_guard");
      await expect(move("14:00")).rejects.toMatchObject({ code: "23P01" });
      await c.query("ROLLBACK TO SAVEPOINT old_guard");
      await c.query(
        await readFile("migrations/009_schedule_guard_scope.sql", "utf8"),
      );
      // Historical overlap remains intact, but a new free time can be saved.
      await move("14:00");
      expect(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM schedule_versions WHERE enrollment_id=$1",
            [enrollment],
          )
        ).rows[0].n,
      ).toBe(2);
      await c.query("SAVEPOINT real_overlap");
      try {
        await move("14:45", "2026-11-01");
        throw new Error("Expected conflict");
      } catch (error) {
        expect(error).toMatchObject({ code: "23P01" });
        expect(JSON.parse((error as any).detail)).toMatchObject({
          time: "15:00",
          end_time: "15:45",
          student: "Otro alumno",
          discipline: "Otro libro",
        });
      }
      await c.query("ROLLBACK TO SAVEPOINT real_overlap");
      // Adjacent classes are allowed, and archived books do not reserve active hours.
      await move("15:45", "2026-11-01");
      await c.query("UPDATE books SET archived_at=now() WHERE id=$1", [
        otherBook,
      ]);
      await move("15:00", "2026-11-10");
      await c.query("ROLLBACK");
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await closeDatabase();
    }
  },
  60000,
);
