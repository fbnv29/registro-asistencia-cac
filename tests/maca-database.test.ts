import "dotenv/config";
import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { transaction, closeDatabase } from "../server/db";
import { analyze } from "../server/maca";
import { loadAdminBooks } from "../server/service";
const enabled = process.env.RUN_INTEGRATION === "true";
afterAll(async () => {
  if (enabled) await closeDatabase();
});
it.skipIf(!enabled)(
  "PostgreSQL rechaza superposición entre libros y concuerda con el análisis",
  async () => {
    if (!["development", "preview"].includes(process.env.APP_ENV || ""))
      throw new Error("Solo desarrollo");
    const teacher = randomUUID(),
      period = randomUUID(),
      books: string[] = [randomUUID(), randomUUID()],
      students = [randomUUID(), randomUUID()],
      enrollments = [randomUUID(), randomUUID()];
    const rollback = new Error("rollback fixture");
    await expect(
      transaction(async (c) => {
        await c.query("INSERT INTO teachers(id,name) VALUES($1,$2)", [
          teacher,
          "Maca prueba",
        ]);
        await c.query(
          "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Maca prueba','2026-06-01','2026-06-30')",
          [period],
        );
        for (let i = 0; i < 2; i++) {
          await c.query(
            "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,password_hash) VALUES($1,$2,$3,'Prueba',1,'fixture')",
            [books[i], teacher, period],
          );
          await c.query(
            "INSERT INTO students(id,full_name) VALUES($1,'Prueba')",
            [students[i]],
          );
          await c.query(
            "INSERT INTO enrollments(id,student_id,book_id,joined_on) VALUES($1,$2,$3,'2026-06-01')",
            [enrollments[i], students[i], books[i]],
          );
        }
        await c.query(
          `INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,'2026-06-01','[{"day":0,"time":"15:00"}]')`,
          [randomUUID(), enrollments[0]],
        );
        await c.query("SAVEPOINT conflict");
        await expect(
          c.query(
            `INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,'2026-06-01','[{"day":0,"time":"15:15"}]')`,
            [randomUUID(), enrollments[1]],
          ),
        ).rejects.toMatchObject({ code: "23P01" });
        await c.query("ROLLBACK TO SAVEPOINT conflict");
        await c.query(
          `INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,'2026-06-01','[{"day":0,"time":"15:45"}]')`,
          [randomUUID(), enrollments[1]],
        );
        const lesson = randomUUID();
        await c.query(
          "INSERT INTO lessons(id,enrollment_id,date,slot,time) VALUES($1,$2,'2026-06-01',0,'15:00')",
          [lesson, enrollments[0]],
        );
        await c.query(
          "INSERT INTO attendance(lesson_id,status) VALUES($1,'present')",
          [lesson],
        );
        const absence = randomUUID();
        await c.query(
          "INSERT INTO lessons(id,enrollment_id,date,slot,time) VALUES($1,$2,'2026-06-08',0,'15:00')",
          [absence, enrollments[0]],
        );
        await c.query(
          "INSERT INTO attendance(lesson_id,status) VALUES($1,'absent')",
          [absence],
        );
        const data = (await loadAdminBooks(c)).filter((b) =>
          books.includes(b.book.id),
        );
        const summary = analyze(
          data,
          "2026-06-01",
          "2026-06-30",
          "attendance",
        ).summary;
        const sql = (
          await c.query(
            "SELECT count(*)::int AS count FROM attendance a JOIN lessons l ON l.id=a.lesson_id JOIN enrollments e ON e.id=l.enrollment_id WHERE e.book_id=ANY($1::uuid[]) AND l.date BETWEEN $2::date AND $3::date",
            [books, "2026-06-01", "2026-06-30"],
          )
        ).rows[0];
        expect(summary).toMatchObject({
          count: sql.count,
          present: 1,
          absent: 1,
          pending: 6,
          suspended: 2,
          percentage: 50,
        });
        const ranking = analyze(data, "2026-06-01", "2026-06-30", "absences");
        const absences = (
          await c.query(
            "SELECT e.student_id,count(*)::int AS count FROM attendance a JOIN lessons l ON l.id=a.lesson_id JOIN enrollments e ON e.id=l.enrollment_id WHERE e.book_id=ANY($1::uuid[]) AND l.date BETWEEN $2::date AND $3::date AND a.status='absent' GROUP BY e.student_id ORDER BY count(*) DESC",
            [books, "2026-06-01", "2026-06-30"],
          )
        ).rows;
        expect(ranking.rows).toHaveLength(1);
        expect(ranking.absenceLeader).toMatchObject({
          absent: absences[0].count,
          ties: 1,
        });
        expect(ranking.rows[0]).toMatchObject({
          Estudiante: "Prueba",
          Ausencias: 1,
          Pendientes: 2,
          Suspendidas: 1,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  },
);

it.skipIf(!enabled)(
  "API real restringe profesores y entrega estadísticas verificables al administrador",
  { timeout: 60000 },
  async () => {
    const { handleApi } = await import("../server/api");
    const { digest } = await import("../server/security");
    const admin = randomUUID(),
      teacher = randomUUID();
    const ids = [digest(admin), digest(teacher)];
    const key = process.env.GEMINI_API_KEY;
    const provider = process.env.MACA_PROVIDER;
    process.env.MACA_PROVIDER = "internal";
    process.env.GEMINI_API_KEY = "";
    try {
      await transaction(async (c) => {
        const book = (await c.query("SELECT id FROM books LIMIT 1")).rows[0];
        if (!book)
          throw new Error("Se requiere al menos un libro en desarrollo.");
        await c.query(
          "INSERT INTO access_sessions(token_hash,kind,book_id,expires_at) VALUES($1,'admin',null,now()+interval '5 minutes'),($2,'book',$3,now()+interval '5 minutes')",
          [...ids, book.id],
        );
      });
      const query = {
        request_id: randomUUID(),
        question: "Asistencia junio de 2026",
        book_id: randomUUID(),
      };
      const call = (token: string) =>
        handleApi(
          new Request("https://cac.test/api/admin/maca", {
            method: "POST",
            headers: {
              origin: "https://cac.test",
              "content-type": "application/json",
              cookie: "cac_session=" + token,
            },
            body: JSON.stringify(query),
          }),
        );
      expect((await call(teacher)).status).toBe(403);
      const response = await call(admin);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.summary).toMatchObject({
        count: 0,
        pending: 0,
        percentage: null,
      });
      expect(result.from).toBe("2026-06-01");
      const metadata = await transaction(
        async (c) =>
          (
            await c.query(
              "SELECT gemini_calls,outcome FROM maca_requests WHERE session_hash=$1",
              [ids[0]],
            )
          ).rows,
      );
      expect(metadata).toEqual([{ gemini_calls: 0, outcome: "ok" }]);
      expect((await call(admin)).status).toBe(409);
    } finally {
      if (provider === undefined) delete process.env.MACA_PROVIDER;
      else process.env.MACA_PROVIDER = provider;
      if (key === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = key;
      await transaction(async (c) => {
        await c.query(
          "DELETE FROM maca_requests WHERE session_hash=ANY($1::text[])",
          [ids],
        );
        await c.query(
          "DELETE FROM access_sessions WHERE token_hash=ANY($1::text[])",
          [ids],
        );
      });
    }
  },
);
