import "dotenv/config";
import { randomUUID } from "node:crypto";
import { transaction, closeDatabase } from "../server/db";
import { hashPassword } from "../server/security";
import { lessonsFor, localToday, type BookData } from "../src/domain";
if (
  process.env.ALLOW_DEMO_SEED !== "true" ||
  !["development", "preview"].includes(process.env.APP_ENV || "")
)
  throw new Error(
    "La carga ficticia requiere ALLOW_DEMO_SEED=true y APP_ENV=development o preview.",
  );
const passwords = {
  admin: process.env.CAC_ADMIN_PASSWORD,
  book: process.env.CAC_DEMO_BOOK_PASSWORD,
};
if (Object.values(passwords).some((v) => !v || v.length < 6 || v.length > 128))
  throw new Error(
    "Configura contraseñas de demostración distintas: CAC_ADMIN_PASSWORD y CAC_DEMO_BOOK_PASSWORD.",
  );
await transaction(async (c) => {
  if ((await c.query("SELECT id FROM books LIMIT 1")).rowCount) {
    console.log("La base ya tiene libros. No se agregaron datos.");
    return;
  }
  const period = {
    id: randomUUID(),
    name: "Período lectivo 2026",
    start_date: "2026-03-01",
    end_date: "2026-11-30",
  };
  await c.query(
    "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,$2,$3,$4)",
    Object.values(period),
  );
  for (const [kind, pw] of [["admin", passwords.admin!]])
    await c.query(
      "INSERT INTO access_keys(kind,password_hash) VALUES($1,$2) ON CONFLICT(kind) DO NOTHING",
      [kind, await hashPassword(pw)],
    );
  const first = [
    "Amalia",
    "Benjamín",
    "Catalina",
    "Diego",
    "Elena",
    "Florencia",
    "Gabriel",
    "Isidora",
    "Joaquín",
    "Josefa",
    "Lucas",
    "Maite",
    "Martín",
    "Matilde",
    "Nicolás",
    "Olivia",
    "Rafael",
    "Renata",
    "Simón",
    "Sofía",
    "Tomás",
    "Valentina",
    "Vicente",
    "Agustina",
    "Antonia",
    "Bruno",
    "Emilia",
    "Felipe",
    "Julieta",
    "Mateo",
  ];
  const last = [
    "Araya",
    "Bravo",
    "Castro",
    "Díaz",
    "Espinoza",
    "Fuentes",
    "González",
    "Herrera",
    "López",
    "Muñoz",
  ];
  const teacherIds = [randomUUID(), randomUUID()];
  for (const [i, teacherName] of [
    "Profesor de ejemplo",
    "Profesora de ejemplo",
  ].entries())
    await c.query("INSERT INTO teachers(id,name) VALUES($1,$2)", [
      teacherIds[i],
      teacherName,
    ]);
  for (const [index, discipline] of [
    "Teclado",
    "Sensibilización musical",
    "Ensamble",
  ].entries()) {
    const book = {
      id: randomUUID(),
      teacher_id: teacherIds[index === 1 ? 1 : 0],
      period_id: period.id,
      discipline,
      sessions_per_week: index === 1 ? 2 : 1,
      duration_minutes: index === 1 ? 60 : 45,
    };
    await c.query(
      "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,duration_minutes,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [...Object.values(book), await hashPassword(passwords.book!)],
    );
    const data: BookData = {
      book,
      period,
      enrollments: [],
      schedules: [],
      suspensions: [],
      attendance: [],
    };
    for (let i = 0; i < (index === 2 ? 8 : 30); i++) {
      const studentId = randomUUID(),
        enrollmentId = randomUUID();
      const joined = i === 29 ? "2026-07-01" : period.start_date;
      const fullName = `${first[i]} ${last[i % last.length]} (ejemplo)`;
      const enrollment = {
        id: enrollmentId,
        student_id: studentId,
        book_id: book.id,
        full_name: fullName,
        joined_on: joined,
        left_on: i === 28 ? "2026-08-31" : null,
      };
      const slots = Array.from({ length: book.sessions_per_week }, (_, s) => ({
        day: index === 1 ? (s === 0 ? 1 : 3) : i % 5,
        time: `${String(14 + Math.floor((i % 10) / 2)).padStart(2, "0")}:${i % 2 ? "45" : "00"}`,
      }));
      const schedule = {
        id: randomUUID(),
        enrollment_id: enrollmentId,
        effective_from: joined,
        slots,
      };
      data.enrollments.push(enrollment);
      data.schedules.push(schedule);
      await c.query("INSERT INTO students(id,full_name) VALUES($1,$2)", [
        studentId,
        fullName,
      ]);
      await c.query(
        "INSERT INTO enrollments(id,student_id,book_id,joined_on,left_on) VALUES($1,$2,$3,$4,$5)",
        [enrollmentId, studentId, book.id, joined, enrollment.left_on],
      );
      await c.query(
        "INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,$3,$4)",
        [schedule.id, enrollmentId, joined, JSON.stringify(slots)],
      );
    }
    const demoLessons = lessonsFor(data).filter((l) => l.date < localToday());
    // Keep the dataset small while providing realistic recent attendance.
    for (const [i, l] of demoLessons
      .filter((l) => l.date >= "2026-10-01")
      .entries()) {
      if (i % 11 === 0) continue;
      const lessonId = randomUUID();
      await c.query(
        "INSERT INTO lessons(id,enrollment_id,date,slot,time) VALUES($1,$2,$3,$4,$5)",
        [lessonId, l.enrollment_id, l.date, l.slot, l.time],
      );
      await c.query("INSERT INTO attendance(lesson_id,status) VALUES($1,$2)", [
        lessonId,
        i % 9 === 0 ? "absent" : i % 7 === 0 ? "justified" : "present",
      ]);
    }
  }
  await c.query(
    "INSERT INTO suspensions(id,scope,start_date,end_date,reason) VALUES($1,'center','2026-09-14','2026-09-20','Receso de Fiestas Patrias')",
    [randomUUID()],
  );
  console.log("Datos ficticios creados: 3 libros, 68 matrículas.");
});
await closeDatabase();
