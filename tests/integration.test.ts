import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { handleApi } from "../server/api";
import { transaction, closeDatabase } from "../server/db";
import { hashPassword } from "../server/security";
import { lessonsFor, type BookData } from "../src/domain";
const enabled = process.env.RUN_INTEGRATION === "true";
const teacherId = randomUUID(),
  periodId = randomUUID(),
  bookIds = [randomUUID(), randomUUID(), randomUUID()],
  studentId = randomUUID(),
  enrollmentId = randomUUID(),
  ip = `test-${randomUUID()}`;
let adminCookie = "",
  bookCookie = "";
const createdSuspensions: string[] = [];
const createdEnrollments: string[] = [];
async function call(path: string, payload?: unknown, cookie = bookCookie) {
  return handleApi(
    new Request("https://cac.test/api" + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Origin: "https://cac.test",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    ip,
  );
}
const describeIntegration = enabled ? describe : describe.skip;
describeIntegration(
  "API con PostgreSQL real en rama de desarrollo",
  { timeout: 60000 },
  () => {
    beforeAll(async () => {
      if (!["development", "preview"].includes(process.env.APP_ENV || ""))
        throw new Error(
          "Las pruebas de integración solo se ejecutan en desarrollo.",
        );
      await transaction(async (c) => {
        await c.query("INSERT INTO teachers(id,name) VALUES($1,$2)", [
          teacherId,
          "Prueba automatizada",
        ]);
        await c.query(
          "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Prueba','2026-03-01','2026-11-30')",
          [periodId],
        );
        for (const id of bookIds)
          await c.query(
            "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,password_hash) VALUES($1,$2,$3,'Prueba',1,$4)",
            [id, teacherId, periodId, await hashPassword("book-test-password")],
          );
        await c.query(
          "INSERT INTO students(id,full_name) VALUES($1,'Estudiante de prueba')",
          [studentId],
        );
        await c.query(
          "INSERT INTO enrollments(id,student_id,book_id,joined_on) VALUES($1,$2,$3,'2026-03-01')",
          [enrollmentId, studentId, bookIds[0]],
        );
        await c.query(
          `INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,'2026-03-01','[{"day":0,"time":"15:00"}]')`,
          [randomUUID(), enrollmentId],
        );
      });
      const admin = await call(
        "/login",
        { kind: "admin", password: process.env.CAC_ADMIN_PASSWORD },
        "",
      );
      expect(admin.status).toBe(200);
      adminCookie = admin.headers.get("set-cookie")!.split(";")[0];
      const book = await call(
        "/login",
        { kind: "book", book_id: bookIds[0], password: "book-test-password" },
        "",
      );
      expect(book.status).toBe(200);
      bookCookie = book.headers.get("set-cookie")!.split(";")[0];
      expect(book.headers.get("set-cookie")).toContain("HttpOnly");
      expect(book.headers.get("set-cookie")).toContain("Secure");
    }, 60000);
    afterAll(async () => {
      await transaction(async (c) => {
        const enrollments = (
          await c.query(
            "SELECT id,student_id FROM enrollments WHERE book_id=ANY($1::uuid[])",
            [bookIds],
          )
        ).rows;
        const enrollmentIds = enrollments.map((e) => e.id),
          studentIds = enrollments.map((e) => e.student_id);
        await c.query(
          "DELETE FROM attendance WHERE lesson_id IN(SELECT id FROM lessons WHERE enrollment_id=ANY($1::uuid[]))",
          [enrollmentIds],
        );
        await c.query(
          "DELETE FROM lessons WHERE enrollment_id=ANY($1::uuid[])",
          [enrollmentIds],
        );
        await c.query(
          "DELETE FROM schedule_versions WHERE enrollment_id=ANY($1::uuid[])",
          [enrollmentIds],
        );
        await c.query("DELETE FROM enrollments WHERE book_id=ANY($1::uuid[])", [
          bookIds,
        ]);
        await c.query("DELETE FROM students WHERE id=ANY($1::uuid[])", [
          studentIds,
        ]);
        await c.query(
          "DELETE FROM access_sessions WHERE book_id=ANY($1::uuid[])",
          [bookIds],
        );
        await c.query(
          "DELETE FROM suspensions WHERE target_id=$1 OR target_id=ANY($2::uuid[]) OR id=ANY($3::uuid[])",
          [teacherId, bookIds, createdSuspensions],
        );
        await c.query("DELETE FROM books WHERE id=ANY($1::uuid[])", [bookIds]);
        await c.query("DELETE FROM teachers WHERE id=$1", [teacherId]);
        await c.query("DELETE FROM periods WHERE id=$1", [periodId]);
      });
      await closeDatabase();
    }, 60000);
    it("no permite entrar con contraseña incorrecta ni acceder a otro libro", async () => {
      expect(
        (
          await call(
            "/login",
            { kind: "book", book_id: bookIds[0], password: "incorrecta" },
            "",
          )
        ).status,
      ).toBe(401);
      expect((await call(`/books/${bookIds[0]}`, undefined, "")).status).toBe(
        403,
      );
      expect((await call(`/books/${bookIds[1]}`)).status).toBe(403);
      expect((await call("/admin")).status).toBe(403);
      expect((await call("/books", { teacher_id: teacherId })).status).toBe(
        403,
      );
    });
    it("la contraseña administrativa permite abrir cualquier libro", async () => {
      const r = await call(
        "/login",
        {
          kind: "book",
          book_id: bookIds[1],
          password: process.env.CAC_ADMIN_PASSWORD,
        },
        "",
      );
      expect(r.status).toBe(200);
      expect((await r.json()).kind).toBe("admin");
      expect(
        (await call(`/books/${bookIds[1]}`, undefined, adminCookie)).status,
      ).toBe(200);
    });
    it("guarda una sola marca por sesión y permite corregirla después", async () => {
      for (const status of ["present", "absent", "justified"])
        expect(
          (
            await call(`/books/${bookIds[0]}/attendance`, {
              enrollment_id: enrollmentId,
              date: "2026-03-02",
              slot: 0,
              status,
            })
          ).status,
        ).toBe(200);
      const data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        data.attendance.filter((a) => a.date === "2026-03-02"),
      ).toHaveLength(1);
      expect(data.attendance.find((a) => a.date === "2026-03-02")?.status).toBe(
        "justified",
      );
      expect(
        (
          await call(`/books/${bookIds[0]}/attendance`, {
            enrollment_id: enrollmentId,
            date: "2026-03-03",
            slot: 0,
            status: "present",
          })
        ).status,
      ).toBe(409);
    });
    it("suspende por profesor, conserva marcas y restaura al quitar suspensiones superpuestas", async () => {
      for (const reason of ["Permiso de prueba", "Otro permiso"])
        expect(
          (
            await call(
              "/admin",
              {
                action: "suspension",
                scope: "teacher",
                target_id: teacherId,
                start_date: "2026-03-02",
                end_date: "2026-03-02",
                reason,
              },
              adminCookie,
            )
          ).status,
        ).toBe(200);
      const suspensions = (
        await (await call("/admin", undefined, adminCookie)).json()
      ).suspensions.filter((s: any) => s.target_id === teacherId);
      createdSuspensions.push(...suspensions.map((s: any) => s.id));
      let data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(lessonsFor(data, "2026-03-02", "2026-03-02")[0].status).toBe(
        "suspended",
      );
      expect(
        (
          await call(`/books/${bookIds[0]}/attendance`, {
            enrollment_id: enrollmentId,
            date: "2026-03-02",
            slot: 0,
            status: "absent",
          })
        ).status,
      ).toBe(409);
      for (const b of bookIds)
        expect(
          (
            await (await call(`/books/${b}`, undefined, adminCookie)).json()
          ).suspensions.filter((s: any) => s.target_id === teacherId),
        ).toHaveLength(2);
      await call(
        "/admin",
        { action: "remove-suspension", id: suspensions[0].id },
        adminCookie,
      );
      data = await (await call(`/books/${bookIds[0]}`)).json();
      expect(lessonsFor(data, "2026-03-02", "2026-03-02")[0].status).toBe(
        "suspended",
      );
      await call(
        "/admin",
        { action: "remove-suspension", id: suspensions[1].id },
        adminCookie,
      );
      data = await (await call(`/books/${bookIds[0]}`)).json();
      expect(lessonsFor(data, "2026-03-02", "2026-03-02")[0].status).toBe(
        "justified",
      );
    });
    it("matricula a mitad de año, cambia el horario desde una fecha y conserva el pasado", async () => {
      let r = await call(`/books/${bookIds[0]}/students`, {
        full_name: "Ingreso tardío de prueba",
        joined_on: "2026-07-01",
        slots: [{ day: 4, time: "16:00" }],
      });
      expect(r.status).toBe(201);
      const e = (await r.json()).id;
      createdEnrollments.push(e);
      r = await call(`/books/${bookIds[0]}/schedule`, {
        enrollment_id: e,
        effective_from: "2026-07-15",
        slots: [{ day: 2, time: "17:00" }],
      });
      expect(r.status).toBe(200);
      let data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      let lessons = lessonsFor(data).filter((l) => l.enrollment_id === e);
      expect(lessons[0].date).toBe("2026-07-03");
      expect(lessons.find((l) => l.date === "2026-07-17")).toBeUndefined();
      expect(lessons.find((l) => l.date === "2026-07-15")?.time).toBe("17:00");
      r = await call(`/books/${bookIds[0]}/students`, {
        enrollment_id: e,
        full_name: "Ingreso tardío de prueba",
        joined_on: "2026-07-01",
        left_on: "2026-07-31",
      });
      expect(r.status).toBe(200);
      data = await (await call(`/books/${bookIds[0]}`)).json();
      lessons = lessonsFor(data).filter((l) => l.enrollment_id === e);
      expect(lessons.every((l) => l.date <= "2026-07-31")).toBe(true);
    });
    it("exporta Excel con las mismas fechas, estados y porcentajes", async () => {
      const r = await call(
        `/books/${bookIds[0]}/export?from=2026-03-02&to=2026-03-08`,
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("spreadsheetml");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await r.arrayBuffer());
      expect(workbook.worksheets).toHaveLength(2);
      expect(workbook.getWorksheet("Resumen")!.getCell("G3").value).toBe(100);
      expect(workbook.getWorksheet("Sesiones")!.getCell("E2").value).toBe(
        "Falta justificada",
      );
    });
    it("limita intentos y restablece contraseñas de libro revocando sesiones", async () => {
      for (let i = 0; i < 15; i++)
        await call(
          "/login",
          { kind: "book", book_id: bookIds[2], password: "incorrecta" },
          "",
        );
      expect(
        (
          await call(
            "/login",
            { kind: "book", book_id: bookIds[2], password: "incorrecta" },
            "",
          )
        ).status,
      ).toBe(429);
      expect(
        (
          await call(
            "/admin",
            {
              action: "password",
              kind: "book",
              book_id: bookIds[0],
              password: "nuevo-password",
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect((await call(`/books/${bookIds[0]}`)).status).toBe(403);
      const r = await call(
        "/login",
        { kind: "book", book_id: bookIds[0], password: "nuevo-password" },
        "",
      );
      expect(r.status).toBe(200);
      bookCookie = r.headers.get("set-cookie")!.split(";")[0];
    });
    it("rechaza contraseñas administrativas y de creación idénticas", async () => {
      expect(
        (
          await call(
            "/admin",
            {
              action: "password",
              kind: "creator",
              password: process.env.CAC_ADMIN_PASSWORD,
            },
            adminCookie,
          )
        ).status,
      ).toBe(400);
    });
    it("cierra la sesión y revoca el acceso al recargar", async () => {
      expect((await call("/logout", {})).status).toBe(200);
      expect(await (await call("/session")).json()).toBe(null);
      expect((await call(`/books/${bookIds[0]}`)).status).toBe(403);
    });
  },
);
