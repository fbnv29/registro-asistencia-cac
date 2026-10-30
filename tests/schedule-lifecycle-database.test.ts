import "dotenv/config";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "@neondatabase/serverless";
import { database, closeDatabase } from "../server/db";
import { applyBookChange } from "../server/changes";
import { administer } from "../server/administration";

const enabled = process.env.RUN_INTEGRATION === "true";
const admin = { kind: "admin" as const, book_id: null };
const [teacher, teacher2, period, book, book2] = Array.from({ length: 5 }, () =>
  randomUUID(),
);
let c: PoolClient;
const add = async (
  targetBook = book,
  time = "14:00",
  day = 0,
  joined = "2026-03-01",
  left: string | null = null,
) => {
  const result = await applyBookChange(c, admin, targetBook, "students", {
    full_name: "Alumno de prueba",
    joined_on: joined,
    left_on: left,
    slots: [{ day, time }],
  });
  if (!result.id) throw new Error("No se creó la matrícula de prueba");
  return { id: result.id };
};
const move = (id: string, time: string, from = "2026-10-30", day = 0) =>
  applyBookChange(c, admin, book, "schedule", {
    enrollment_id: id,
    effective_from: from,
    slots: [{ day, time }],
  });
const retire = (id: string, left: string | null) =>
  applyBookChange(c, admin, book, "students", {
    enrollment_id: id,
    full_name: "Nombre editado",
    joined_on: "2026-03-01",
    left_on: left,
  });
const archive = (entity: "book" | "period", id: string, archived: boolean) =>
  administer(c, admin, { action: "archive", entity, id, archived });
async function rejectsWithoutChanges(action: () => Promise<unknown>) {
  await c.query("SAVEPOINT rejected_change");
  try {
    await expect(action()).rejects.toThrow();
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT rejected_change");
  }
}
async function seedLegacyOverlap() {
  const { id } = await add();
  const other = await add(book, "15:00");
  await c.query(
    "ALTER TABLE schedule_versions DISABLE TRIGGER schedule_integrity",
  );
  await c.query(
    `UPDATE schedule_versions SET slots='[{"day":0,"time":"14:00"}]' WHERE enrollment_id=$1`,
    [other.id],
  );
  await c.query(
    "ALTER TABLE schedule_versions ENABLE TRIGGER schedule_integrity",
  );
  return { id, other: other.id };
}

describe.skipIf(!enabled)(
  "ciclo de alumnos y horarios con PostgreSQL aislado",
  { timeout: 60000 },
  () => {
    beforeAll(async () => {
      if (!["development", "preview"].includes(process.env.APP_ENV || ""))
        throw new Error("Solo desarrollo o preview.");
      c = await database().connect();
      await c.query("BEGIN");
      const schema = `cac_lifecycle_${randomUUID().replaceAll("-", "")}`;
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET LOCAL search_path TO ${schema},public`);
      for (const table of [
        "teachers",
        "periods",
        "books",
        "students",
        "enrollments",
        "schedule_versions",
        "lessons",
        "attendance",
        "suspensions",
        "holiday_exceptions",
        "audit_log",
      ])
        await c.query(
          `CREATE TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`,
        );
      await c.query(
        "CREATE UNIQUE INDEX test_schedule_version ON schedule_versions(enrollment_id,effective_from)",
      );
      for (const file of [
        "006_schedule_integrity.sql",
        "009_schedule_guard_scope.sql",
        "010_schedule_lifecycle_integrity.sql",
      ])
        await c.query(await readFile(`migrations/${file}`, "utf8"));
      await c.query(
        "INSERT INTO teachers(id,name) VALUES($1,'Profesor'),($2,'Otro profesor')",
        [teacher, teacher2],
      );
      await c.query(
        "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Prueba','2026-03-01','2027-11-30')",
        [period],
      );
      await c.query(
        "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,duration_minutes) VALUES($1,$3,$4,'Teclado',1,30),($2,$3,$4,'Otro libro',1,45)",
        [book, book2, teacher, period],
      );
    }, 60000);
    beforeEach(async () => {
      await c.query("SAVEPOINT test_case");
    });
    afterEach(async () => {
      await c.query("ROLLBACK TO SAVEPOINT test_case");
    });
    afterAll(async () => {
      if (c) {
        await c.query("ROLLBACK");
        c.release();
      }
      await closeDatabase();
    });

    it("alta libre, contigua y otro día; rechaza simultáneos y cruces parciales", async () => {
      await add();
      await add(book, "14:30");
      await add(book, "14:00", 1);
      await rejectsWithoutChanges(() => add(book, "14:00"));
      await rejectsWithoutChanges(() => add(book, "14:15"));
    });
    it("rechaza cruces entre libros del mismo profesor y permite profesores distintos", async () => {
      await add();
      await rejectsWithoutChanges(() => add(book2));
      await c.query("UPDATE books SET teacher_id=$1 WHERE id=$2", [
        teacher2,
        book2,
      ]);
      await add(book2);
    });
    it("un conflicto antiguo entre otros alumnos no bloquea una nueva alta libre", async () => {
      await seedLegacyOverlap();
      await add(book, "16:00");
    });
    it("modificar nombre, retirar o adelantar retiro no revive cruces históricos", async () => {
      const { id } = await seedLegacyOverlap();
      await retire(id, null);
      await retire(id, "2026-10-30");
      await retire(id, "2026-06-01");
      expect(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM schedule_versions WHERE enrollment_id=$1",
            [id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("libera desde el día posterior al último día de matrícula; rechaza reincorporar si hay reemplazo", async () => {
      const { id } = await add(book, "14:00", 0, "2026-03-01", "2026-06-01");
      await rejectsWithoutChanges(() => add(book, "14:00", 0, "2026-06-01"));
      await add(book, "14:00", 0, "2026-06-02");
      await rejectsWithoutChanges(() => retire(id, null));
      expect(
        (
          await c.query("SELECT left_on::text FROM enrollments WHERE id=$1", [
            id,
          ])
        ).rows[0].left_on,
      ).toBe("2026-06-01");
    });
    it("reincorpora sin bloquear por un cruce únicamente en el antiguo último día", async () => {
      const { id, other } = await seedLegacyOverlap();
      await retire(id, "2026-06-01");
      await retire(other, "2026-06-01");
      await retire(id, null);
    });
    it("mueve un alumno sin conflictos con su horario anterior ni con el historial", async () => {
      const { id } = await seedLegacyOverlap();
      await move(id, "15:00");
      await move(id, "16:00"); // replaces the version with the same effective date
      expect(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM schedule_versions WHERE enrollment_id=$1",
            [id],
          )
        ).rows[0].n,
      ).toBe(2);
    });
    it("una versión futura intacta no bloquea editar una versión anterior", async () => {
      const { id } = await seedLegacyOverlap();
      await c.query(
        "ALTER TABLE schedule_versions DISABLE TRIGGER schedule_integrity",
      );
      await c.query(
        `INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,'2026-07-01','[{"day":0,"time":"14:00"}]')`,
        [randomUUID(), id],
      );
      await c.query(
        "ALTER TABLE schedule_versions ENABLE TRIGGER schedule_integrity",
      );
      await move(id, "15:00", "2026-06-01");
      expect(
        (
          await c.query(
            "SELECT slots FROM schedule_versions WHERE enrollment_id=$1 AND effective_from='2026-07-01'",
            [id],
          )
        ).rows[0].slots[0].time,
      ).toBe("14:00");
    });
    it("guardar el mismo horario no bloquea ni crea versiones innecesarias", async () => {
      const { id } = await seedLegacyOverlap();
      await move(id, "14:00");
      expect(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM schedule_versions WHERE enrollment_id=$1",
            [id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("archivar libera horarios y restaurar un libro ocupado se rechaza sin cambios parciales", async () => {
      await add();
      await archive("book", book, true);
      await add(book2);
      await rejectsWithoutChanges(() => archive("book", book, false));
      expect(
        (await c.query("SELECT archived_at FROM books WHERE id=$1", [book]))
          .rows[0].archived_at,
      ).not.toBeNull();
      await archive("book", book2, true);
      await archive("book", book, false);
    });
    it("restaurar un período también valida horas ocupadas en otros períodos", async () => {
      const p2 = randomUUID();
      await c.query(
        "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Otro período','2026-03-01','2027-11-30')",
        [p2],
      );
      await c.query("UPDATE books SET period_id=$1 WHERE id=$2", [p2, book2]);
      await add();
      await archive("period", period, true);
      await add(book2);
      await rejectsWithoutChanges(() => archive("period", period, false));
      await archive("book", book2, true);
      await archive("period", period, false);
    });
    it("renombrar libro o reducir duración no bloquea por cruces preexistentes", async () => {
      await seedLegacyOverlap();
      await administer(c, admin, {
        action: "edit-book",
        id: book,
        discipline: "Nuevo nombre",
        teacher_id: teacher,
      });
      await administer(c, admin, {
        action: "duration",
        book_id: book,
        duration_minutes: 30,
      });
      await administer(c, admin, {
        action: "duration",
        book_id: book,
        duration_minutes: 20,
      });
    });
    it("aumentar duración detecta el cruce, también entre libros", async () => {
      await add();
      await add(book2, "14:30");
      await rejectsWithoutChanges(() =>
        administer(c, admin, {
          action: "duration",
          book_id: book,
          duration_minutes: 45,
        }),
      );
    });
    it("cambiar profesor comprueba sus otros libros", async () => {
      await add();
      await c.query("UPDATE books SET teacher_id=$1 WHERE id=$2", [
        teacher2,
        book2,
      ]);
      await add(book2);
      await rejectsWithoutChanges(() =>
        administer(c, admin, {
          action: "edit-book",
          id: book,
          discipline: "Teclado",
          teacher_id: teacher2,
        }),
      );
    });
    it("extender el período detecta cruces en las fechas nuevas", async () => {
      const p2 = randomUUID();
      await c.query(
        "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Diciembre','2027-12-01','2027-12-31')",
        [p2],
      );
      await c.query("UPDATE books SET period_id=$1 WHERE id=$2", [p2, book2]);
      await add();
      await add(book2, "14:00", 0, "2027-12-01");
      await rejectsWithoutChanges(() =>
        administer(c, admin, {
          action: "edit-period",
          id: period,
          name: "Extendido",
          start_date: "2026-03-01",
          end_date: "2027-12-31",
        }),
      );
    });
    it("mantiene las asistencias al retirar y rechaza horarios que las dejan fuera", async () => {
      const { id } = await add();
      const lesson = randomUUID();
      await c.query(
        "INSERT INTO lessons(id,enrollment_id,date,slot,time) VALUES($1,$2,'2026-11-02',0,'14:00')",
        [lesson, id],
      );
      await c.query(
        "INSERT INTO attendance(lesson_id,status) VALUES($1,'present')",
        [lesson],
      );
      await rejectsWithoutChanges(() => move(id, "15:00", "2026-10-30", 1));
      await retire(id, "2026-11-30");
      expect(
        (
          await c.query("SELECT status FROM attendance WHERE lesson_id=$1", [
            lesson,
          ])
        ).rows[0].status,
      ).toBe("present");
    });
    it("rechaza terminar después de medianoche y admite terminar exactamente a medianoche", async () => {
      await rejectsWithoutChanges(() => add(book, "23:45"));
      await add(book, "23:30");
    });
    it("rechaza sesiones duplicadas o parcialmente cruzadas del mismo alumno", async () => {
      await c.query("UPDATE books SET sessions_per_week=2 WHERE id=$1", [book]);
      await rejectsWithoutChanges(() =>
        applyBookChange(c, admin, book, "students", {
          full_name: "Doble",
          joined_on: "2026-03-01",
          slots: [
            { day: 0, time: "14:00" },
            { day: 0, time: "14:00" },
          ],
        }),
      );
      await rejectsWithoutChanges(() =>
        applyBookChange(c, admin, book, "students", {
          full_name: "Doble",
          joined_on: "2026-03-01",
          slots: [
            { day: 0, time: "14:00" },
            { day: 0, time: "14:15" },
          ],
        }),
      );
      await applyBookChange(c, admin, book, "students", {
        full_name: "Doble",
        joined_on: "2026-03-01",
        slots: [
          { day: 0, time: "14:00" },
          { day: 0, time: "14:30" },
        ],
      });
    });
  },
);
