/** Synthetic workload, development database only; all fixtures are rolled back. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { transaction, closeDatabase } from "../server/db";
import { loadAdminBooks } from "../server/service";
import { analyze } from "../server/maca";
if (!["development", "preview"].includes(process.env.APP_ENV || ""))
  throw new Error("Solo desarrollo o preview.");
const rollback = new Error("rollback benchmark");
const teachers = Array.from({ length: 50 }, () => ({
  id: randomUUID(),
  book: randomUUID(),
}));
const members = teachers.flatMap((t) =>
  Array.from({ length: 22 }, (_, i) => ({
    id: randomUUID(),
    student: randomUUID(),
    book: t.book,
    time: `${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
  })),
);
const period = randomUUID();
try {
  await transaction(async (c) => {
    await c.query("SET LOCAL statement_timeout='60s'");
    await c.query(
      "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Benchmark Maca','2026-06-01','2026-06-30')",
      [period],
    );
    await c.query(
      "INSERT INTO teachers(id,name) SELECT id,'Benchmark' FROM jsonb_to_recordset($1::jsonb) AS t(id uuid)",
      [JSON.stringify(teachers)],
    );
    await c.query(
      "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,duration_minutes,password_hash) SELECT book,id,$2,'Benchmark',1,25,'fixture' FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,book uuid)",
      [JSON.stringify(teachers), period],
    );
    await c.query(
      "INSERT INTO students(id,full_name) SELECT student,'Sintético' FROM jsonb_to_recordset($1::jsonb) AS t(student uuid)",
      [JSON.stringify(members)],
    );
    await c.query(
      "INSERT INTO enrollments(id,student_id,book_id,joined_on) SELECT id,student,book,'2026-06-01'::date FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,student uuid,book uuid)",
      [JSON.stringify(members)],
    );
    await c.query(
      "INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) SELECT gen_random_uuid(),id,'2026-06-01'::date,jsonb_build_array(jsonb_build_object('day',0,'time',time)) FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,time text)",
      [JSON.stringify(members)],
    );
    await c.query(
      "INSERT INTO lessons(id,enrollment_id,date,slot,time) SELECT gen_random_uuid(),id,d::date,0,time::time FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,time text) CROSS JOIN generate_series('2026-06-01'::date,'2026-06-30'::date,interval '7 days') d",
      [JSON.stringify(members)],
    );
    await c.query(
      "INSERT INTO attendance(lesson_id,status) SELECT l.id,'present' FROM lessons l JOIN enrollments e ON e.id=l.enrollment_id JOIN books b ON b.id=e.book_id WHERE b.period_id=$1",
      [period],
    );
    const before = process.memoryUsage().heapUsed,
      start = performance.now();
    const books = (await loadAdminBooks(c)).filter(
      (b) => b.book.period_id === period,
    );
    const loaded = performance.now();
    const result = analyze(books, "2026-06-01", "2026-06-30", "attendance");
    const analyzed = performance.now();
    const count = (
      await c.query(
        "SELECT count(*)::int AS count FROM lessons l JOIN enrollments e ON e.id=l.enrollment_id JOIN books b ON b.id=e.book_id WHERE b.period_id=$1",
        [period],
      )
    ).rows[0].count;
    if (
      count !== 5500 ||
      result.summary.count !== 4400 ||
      result.summary.suspended !== 1100
    )
      throw new Error("Cifras inesperadas");
    console.log(
      JSON.stringify(
        {
          teachers: 50,
          storedRecords: count,
          loadSqlAndCalendarMs: Math.round(loaded - start),
          aggregationMs: Math.round(analyzed - loaded),
          totalMs: Math.round(analyzed - start),
          heapDeltaMiB:
            Math.round(
              ((process.memoryUsage().heapUsed - before) / 1048576) * 10,
            ) / 10,
          summary: result.summary,
          notes:
            "Incluye latencia de red y libros preexistentes; excluye Gemini y arranque Netlify. Feriado 29 junio: 1100 suspendidas. Datos sintéticos revertidos.",
        },
        null,
        2,
      ),
    );
    throw rollback;
  });
} catch (e) {
  if (e !== rollback) throw e;
} finally {
  await closeDatabase();
}
