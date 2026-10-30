import "dotenv/config";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "@neondatabase/serverless";
import { database, closeDatabase } from "../server/db";
import { applyBookChange } from "../server/changes";
import { previewSchedule } from "../server/scheduleReview";
import { loadBook, setAttendance } from "../server/service";
import { proposeChange, reviewRequest } from "../server/requests";
import { lessonsFor, summarize } from "../src/domain";

const admin = { kind: "admin" as const, book_id: null };
const book = randomUUID(),
  enrollment = randomUUID(),
  teacher = randomUUID(),
  period = randomUUID(),
  student = randomUUID();
let c: PoolClient;
const change = {
  enrollment_id: enrollment,
  effective_from: "2026-06-03",
  slots: [{ day: 2, time: "15:00" }],
};
const transfer = {
  from_date: "2026-06-09",
  from_slot: 0,
  to_date: "2026-06-24",
  to_slot: 0,
};
async function mark(
  date: string,
  status: "present" | "absent" | "justified",
  revision = 0,
) {
  await setAttendance(c, admin, book, {
    enrollment_id: enrollment,
    date,
    slot: 0,
    status,
    expected_revision: revision,
  });
}
async function checkedChange() {
  const preview = await previewSchedule(c, admin, book, change);
  return {
    ...change,
    review_token: preview.review_token,
    transfers: [transfer],
  };
}
describe.skipIf(process.env.RUN_INTEGRATION !== "true")(
  "cambio de horario con traslados en PostgreSQL aislado",
  { timeout: 60000 },
  () => {
    beforeAll(async () => {
      if (!["development", "preview"].includes(process.env.APP_ENV || ""))
        throw new Error("Solo desarrollo o preview.");
      c = await database().connect();
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout=15000");
      await c.query("SET LOCAL lock_timeout=5000");
      const schema = `cac_review_${randomUUID().replaceAll("-", "")}`;
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET LOCAL search_path TO ${schema}`);
      for (const file of [
        "001_initial.sql",
        "002_change_requests.sql",
        "003_student_notes_and_holiday_exceptions.sql",
        "004_archive_and_revisions.sql",
        "006_schedule_integrity.sql",
        "009_schedule_guard_scope.sql",
        "010_schedule_lifecycle_integrity.sql",
      ])
        await c.query(await readFile(`migrations/${file}`, "utf8"));
      await c.query("INSERT INTO teachers(id,name) VALUES($1,'Prueba')", [
        teacher,
      ]);
      await c.query(
        "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Prueba','2026-03-01','2026-11-30')",
        [period],
      );
      await c.query(
        "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,password_hash) VALUES($1,$2,$3,'Piano',1,'test')",
        [book, teacher, period],
      );
      await c.query("INSERT INTO students(id,full_name) VALUES($1,'Prueba')", [
        student,
      ]);
      await c.query(
        "INSERT INTO enrollments(id,student_id,book_id,joined_on) VALUES($1,$2,$3,'2026-03-01')",
        [enrollment, student, book],
      );
      await c.query(
        "INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,'2026-03-01',$3)",
        [randomUUID(), enrollment, JSON.stringify([{ day: 1, time: "14:00" }])],
      );
    });
    beforeEach(async () => {
      await c.query("SAVEPOINT scenario");
      await mark("2026-06-02", "present");
      await mark("2026-06-09", "absent");
    });
    afterEach(async () => {
      await c.query("ROLLBACK TO SAVEPOINT scenario");
    });
    afterAll(async () => {
      if (c) {
        await c.query("ROLLBACK");
        c.release();
      }
      await closeDatabase();
    });

    it("traslada entre semanas, conserva el historial, la revisión y los totales sin duplicar", async () => {
      await applyBookChange(c, admin, book, "schedule", await checkedChange());
      const data = await loadBook(c, book);
      const lessons = lessonsFor(data);
      expect(lessons.find((l) => l.date === "2026-06-02")?.status).toBe(
        "present",
      );
      expect(lessons.find((l) => l.date === "2026-06-24")?.status).toBe(
        "absent",
      );
      expect(lessons.find((l) => l.date === "2026-06-10")?.status).toBe(
        "pending",
      );
      expect(summarize(lessons).count).toBe(2);
      expect(data.attendance.filter((a) => a.status)).toHaveLength(2);
      expect(
        data.attendance.find((a) => a.date === "2026-06-09")?.revision,
      ).toBeGreaterThan(1);
      const audit = (
        await c.query(
          "SELECT details FROM audit_log WHERE action='schedule.set' ORDER BY id DESC LIMIT 1",
        )
      ).rows[0].details;
      expect(audit.transfers[0]).toMatchObject({
        from: { date: "2026-06-09", time: "14:00" },
        to: { date: "2026-06-24", time: "15:00" },
        status: "absent",
      });
    });
    it("envía sin modificar y aprueba después de serializar el payload en jsonb", async () => {
      const request = await proposeChange(
        c,
        { kind: "book", book_id: book },
        book,
        "schedule.update",
        await checkedChange(),
      );
      expect(
        (await loadBook(c, book)).attendance.find(
          (a) => a.date === "2026-06-09",
        )?.status,
      ).toBe("absent");
      await reviewRequest(c, admin, request.id, {
        decision: "approve",
        note: "",
      });
      const data = await loadBook(c, book);
      expect(summarize(lessonsFor(data)).count).toBe(2);
      expect(
        lessonsFor(data).find((l) => l.date === "2026-06-24")?.status,
      ).toBe("absent");
    });
    it("rechaza aprobar si cambió una asistencia sin modificar horario ni solicitud", async () => {
      const request = await proposeChange(
        c,
        { kind: "book", book_id: book },
        book,
        "schedule.update",
        await checkedChange(),
      );
      await mark("2026-06-09", "justified", 1);
      await expect(
        reviewRequest(c, admin, request.id, { decision: "approve", note: "" }),
      ).rejects.toThrow("Vuelve a revisar");
      expect(
        (
          await c.query("SELECT status FROM change_requests WHERE id=$1", [
            request.id,
          ])
        ).rows[0].status,
      ).toBe("pending");
      expect((await loadBook(c, book)).schedules).toHaveLength(1);
    });
    it("revierte horario y traslados si falla una escritura posterior", async () => {
      const input = await checkedChange();
      await c.query(
        `CREATE FUNCTION reject_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo de prueba'; END $$`,
      );
      await c.query(
        "CREATE TRIGGER reject_transfer BEFORE INSERT ON attendance FOR EACH ROW EXECUTE FUNCTION reject_transfer()",
      );
      await c.query("SAVEPOINT apply_attempt");
      await expect(
        applyBookChange(c, admin, book, "schedule", input),
      ).rejects.toThrow("fallo de prueba");
      await c.query("ROLLBACK TO SAVEPOINT apply_attempt");
      const data = await loadBook(c, book);
      expect(data.schedules).toHaveLength(1);
      expect(data.attendance.find((a) => a.date === "2026-06-09")?.status).toBe(
        "absent",
      );
      expect(data.attendance.some((a) => a.date === "2026-06-24")).toBe(false);
    });
  },
);
