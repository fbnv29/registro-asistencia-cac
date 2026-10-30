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
async function call(
  path: string,
  payload?: unknown,
  cookie = bookCookie,
  panel = true,
) {
  // Administrative fixture edits use the privileged panel routes.
  if (
    panel &&
    cookie === adminCookie &&
    payload !== undefined &&
    /^\/books\/[^/]+\/(students|schedule)$/.test(path)
  )
    path = "/admin" + path;
  // Legacy scenarios use the latest revision; dedicated conflict tests supply it explicitly.
  if (
    payload &&
    /\/books\/[^/]+\/(attendance|notes)$/.test(path) &&
    !("expected_revision" in (payload as any))
  ) {
    const book = path.split("/")[2];
    const data = await (await call(`/books/${book}`, undefined, cookie)).json();
    const value = payload as any;
    const revision = path.endsWith("/notes")
      ? data.enrollments?.find((e: any) => e.id === value.enrollment_id)
          ?.note_revision
      : data.attendance?.find(
          (a: any) =>
            a.enrollment_id === value.enrollment_id &&
            a.date === value.date &&
            a.slot === value.slot,
        )?.revision;
    payload = { ...value, expected_revision: revision || 0 };
  }
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
        await c.query(
          "DELETE FROM change_requests WHERE book_id=ANY($1::uuid[])",
          [bookIds],
        );
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
        401,
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
      let r = await call(
        `/books/${bookIds[0]}/students`,
        {
          full_name: "Ingreso tardío de prueba",
          joined_on: "2026-07-01",
          slots: [{ day: 4, time: "16:00" }],
        },
        adminCookie,
      );
      expect(r.status).toBe(201);
      const e = (await r.json()).id;
      createdEnrollments.push(e);
      r = await call(
        `/books/${bookIds[0]}/schedule`,
        {
          enrollment_id: e,
          effective_from: "2026-07-15",
          slots: [{ day: 2, time: "17:00" }],
        },
        adminCookie,
      );
      expect(r.status).toBe(200);
      let data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      let lessons = lessonsFor(data).filter((l) => l.enrollment_id === e);
      expect(lessons[0].date).toBe("2026-07-03");
      expect(lessons.find((l) => l.date === "2026-07-17")).toBeUndefined();
      expect(lessons.find((l) => l.date === "2026-07-15")?.time).toBe("17:00");
      const withdrawal = {
        enrollment_id: e,
        full_name: "Ingreso tardío de prueba",
        joined_on: "2026-07-01",
        left_on: "2026-07-31",
      };
      expect(
        (await call(`/books/${bookIds[0]}/students`, withdrawal)).status,
      ).toBe(202);
      expect(
        (await call(`/books/${bookIds[0]}/students`, withdrawal, adminCookie))
          .status,
      ).toBe(200);
      data = await (
        await call(`/books/${bookIds[0]}`, undefined, adminCookie)
      ).json();
      lessons = lessonsFor(data).filter((l) => l.enrollment_id === e);
      expect(lessons.length).toBeGreaterThan(0);
      expect(lessons.every((l) => l.date <= "2026-07-31")).toBe(true);
      const teacherData: BookData = await (
        await call(`/books/${bookIds[0]}`)
      ).json();
      expect(teacherData.enrollments.some((row) => row.id === e)).toBe(false);
      expect(teacherData.schedules.some((row) => row.enrollment_id === e)).toBe(
        false,
      );
      expect(
        teacherData.attendance.some((row) => row.enrollment_id === e),
      ).toBe(false);
      expect(
        (
          await call(`/books/${bookIds[0]}/students`, {
            ...withdrawal,
            left_on: null,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call(`/books/${bookIds[0]}/attendance`, {
            enrollment_id: e,
            date: "2026-07-03",
            slot: 0,
            status: "present",
          })
        ).status,
      ).toBe(409);
      expect((await call("/admin/overview")).status).toBe(403);
      const overview = await (
        await call("/admin/overview", undefined, adminCookie)
      ).json();
      const fullBook = overview.books.find(
        (d: BookData) => d.book.id === bookIds[0],
      );
      expect(
        fullBook.enrollments.some(
          (row: any) => row.id === e && row.left_on === "2026-07-31",
        ),
      ).toBe(true);
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
    it("mantiene el alta pendiente hasta aprobarla y evita duplicar solicitudes o aplicar dos veces", async () => {
      const input = {
        full_name: "Propuesta de prueba",
        joined_on: "2026-10-01",
        slots: [{ day: 1, time: "14:00" }],
      };
      const response = await call(`/books/${bookIds[0]}/students`, input);
      expect(response.status).toBe(202);
      const request = await response.json();
      expect(
        (await (await call(`/books/${bookIds[0]}`)).json()).enrollments.some(
          (e: any) => e.full_name === input.full_name,
        ),
      ).toBe(false);
      const duplicate = await (
        await call(`/books/${bookIds[0]}/students`, input)
      ).json();
      expect(duplicate.id).toBe(request.id);
      expect(
        (
          await call(`/admin/requests/${request.id}`, {
            decision: "approve",
            note: "",
          })
        ).status,
      ).toBe(403);
      expect((await call("/admin/requests")).status).toBe(403);
      const queue = await (await call(`/books/${bookIds[0]}/requests`)).json();
      expect(queue.requests.find((r: any) => r.id === request.id).status).toBe(
        "pending",
      );
      expect(
        (
          await call(
            `/admin/requests/${request.id}`,
            { decision: "approve", note: "Alta confirmada" },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      const data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        data.enrollments.filter((e) => e.full_name === input.full_name),
      ).toHaveLength(1);
      expect(
        (
          await call(
            `/admin/requests/${request.id}`,
            { decision: "approve", note: "" },
            adminCookie,
          )
        ).status,
      ).toBe(409);
      const history = await (
        await call(`/books/${bookIds[0]}/requests`)
      ).json();
      expect(
        history.requests.find((r: any) => r.id === request.id),
      ).toMatchObject({ status: "approved", review_note: "Alta confirmada" });
    });
    it("conserva el horario vigente hasta la aprobación y después muestra el nuevo", async () => {
      const input = {
        enrollment_id: enrollmentId,
        effective_from: "2026-11-01",
        slots: [{ day: 2, time: "17:30" }],
      };
      const response = await call(`/books/${bookIds[0]}/schedule`, input);
      expect(response.status).toBe(202);
      const request = await response.json();
      let data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        data.schedules.some(
          (s) =>
            s.effective_from === input.effective_from &&
            s.enrollment_id === enrollmentId,
        ),
      ).toBe(false);
      expect(
        (
          await call(
            `/admin/requests/${request.id}`,
            { decision: "approve", note: "" },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      data = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        data.schedules.find(
          (s) =>
            s.effective_from === input.effective_from &&
            s.enrollment_id === enrollmentId,
        )?.slots,
      ).toEqual(input.slots);
      expect(
        data.attendance.find(
          (a) => a.enrollment_id === enrollmentId && a.date === "2026-03-02",
        )?.status,
      ).toBe("justified");
    });
    it("rechaza una propuesta sin modificar la ficha y muestra la observación al profesor", async () => {
      const response = await call(`/books/${bookIds[0]}/students`, {
        enrollment_id: enrollmentId,
        full_name: "Nombre rechazado",
        joined_on: "2026-03-01",
      });
      expect(response.status).toBe(202);
      const request = await response.json();
      expect(
        (
          await call(
            `/admin/requests/${request.id}`,
            { decision: "reject", note: "Revisa los apellidos" },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      const data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        data.enrollments.find((e) => e.id === enrollmentId)?.full_name,
      ).toBe("Estudiante de prueba");
      const queue = await (await call(`/books/${bookIds[0]}/requests`)).json();
      expect(
        queue.requests.find((r: any) => r.id === request.id),
      ).toMatchObject({
        status: "rejected",
        review_note: "Revisa los apellidos",
      });
    });
    it("detecta cambios administrativos posteriores y no sobrescribe una ficha con una solicitud obsoleta", async () => {
      const response = await call(`/books/${bookIds[0]}/students`, {
        enrollment_id: enrollmentId,
        full_name: "Propuesta obsoleta",
        joined_on: "2026-03-01",
      });
      const request = await response.json();
      expect(response.status).toBe(202);
      expect(
        (
          await call(
            `/books/${bookIds[0]}/students`,
            {
              enrollment_id: enrollmentId,
              full_name: "Nombre actualizado por administración",
              joined_on: "2026-03-01",
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            `/admin/requests/${request.id}`,
            { decision: "approve", note: "" },
            adminCookie,
          )
        ).status,
      ).toBe(409);
      const data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        data.enrollments.find((e) => e.id === enrollmentId)?.full_name,
      ).toBe("Nombre actualizado por administración");
      const queue = await (await call(`/books/${bookIds[0]}/requests`)).json();
      expect(queue.requests.find((r: any) => r.id === request.id).status).toBe(
        "pending",
      );
    });
    it("solo administración crea libros y puede aprobar la propuesta de un profesor sin exponer contraseñas", async () => {
      const input = {
        teacher_id: teacherId,
        period_id: periodId,
        discipline: "Libro solicitado de prueba",
        sessions_per_week: 2,
        password: "new-book-secret",
      };
      expect((await call("/books", input)).status).toBe(403);
      expect(
        (
          await call(
            "/login",
            { kind: "creator", password: process.env.CAC_CREATOR_PASSWORD },
            "",
          )
        ).status,
      ).toBe(403);
      const proposed = await call(`/books/${bookIds[0]}/requests`, {
        kind: "book.create",
        data: input,
      });
      expect(proposed.status).toBe(202);
      const request = await proposed.json();
      const queue = await (
        await call("/admin/requests", undefined, adminCookie)
      ).json();
      expect(JSON.stringify(queue)).not.toContain("new-book-secret");
      expect(JSON.stringify(queue)).not.toContain("scrypt:");
      const before = await (await call("/catalog")).json();
      expect(
        before.books.some((b: any) => b.discipline === input.discipline),
      ).toBe(false);
      const approved = await call(
        `/admin/requests/${request.id}`,
        { decision: "approve", note: "" },
        adminCookie,
      );
      expect(approved.status).toBe(200);
      const result = await approved.json();
      bookIds.push(result.result.id);
      expect(
        (
          await call(
            "/login",
            {
              kind: "book",
              book_id: result.result.id,
              password: input.password,
            },
            "",
          )
        ).status,
      ).toBe(200);
    });
    it("deja pendientes los cambios hechos desde el libro incluso con sesión administrativa y guarda notas sin aprobación", async () => {
      const before: BookData = await (
        await call(`/books/${bookIds[0]}`, undefined, adminCookie)
      ).json();
      const original = before.enrollments.find((e) => e.id === enrollmentId)!;
      const proposal = await call(
        `/books/${bookIds[0]}/students`,
        {
          enrollment_id: enrollmentId,
          full_name: "Cambio desde el libro",
          joined_on: original.joined_on,
        },
        adminCookie,
        false,
      );
      expect(proposal.status).toBe(202);
      const request = await proposal.json();
      expect(
        (
          await (
            await call(`/books/${bookIds[0]}`, undefined, adminCookie)
          ).json()
        ).enrollments.find((e: any) => e.id === enrollmentId).full_name,
      ).toBe(original.full_name);
      expect(
        (
          await call(`/books/${bookIds[0]}/notes`, {
            enrollment_id: enrollmentId,
            note: "Le gusta la música rock.",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(`/admin/books/${bookIds[0]}/students`, {
            enrollment_id: enrollmentId,
            full_name: "No autorizado",
            joined_on: original.joined_on,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            `/admin/requests/${request.id}`,
            { decision: "approve", note: "" },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      const after: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        after.enrollments.find((e) => e.id === enrollmentId),
      ).toMatchObject({
        full_name: "Cambio desde el libro",
        note: "Le gusta la música rock.",
      });
      expect(
        (
          await call(`/books/${bookIds[0]}/notes`, {
            enrollment_id: enrollmentId,
            note: "x".repeat(501),
          })
        ).status,
      ).toBe(400);
    });
    it("bloquea altas y propuestas con horario ocupado y aplica feriados nacionales automáticamente", async () => {
      const input = {
        full_name: "Horario ocupado",
        joined_on: "2026-03-01",
        slots: [{ day: 0, time: "15:00" }],
      };
      expect((await call(`/books/${bookIds[0]}/students`, input)).status).toBe(
        409,
      );
      expect(
        (await call(`/books/${bookIds[0]}/students`, input, adminCookie))
          .status,
      ).toBe(409);
      const data: BookData = await (await call(`/books/${bookIds[0]}`)).json();
      expect(
        data.suspensions.some(
          (s) => s.source === "holiday" && s.start_date === "2026-05-01",
        ),
      ).toBe(true);
      const created = await call(
        `/books/${bookIds[0]}/students`,
        {
          full_name: "Sesión en feriado",
          joined_on: "2026-05-01",
          left_on: "2026-05-01",
          slots: [{ day: 4, time: "18:00" }],
        },
        adminCookie,
      );
      expect(created.status).toBe(201);
      const e = (await created.json()).id;
      expect(
        (
          await call(
            `/books/${bookIds[0]}/attendance`,
            {
              enrollment_id: e,
              date: "2026-05-01",
              slot: 0,
              status: "present",
            },
            adminCookie,
          )
        ).status,
      ).toBe(409);
    });
    it("detecta revisiones obsoletas incluso después de volver a pendiente", async () => {
      const path = `/books/${bookIds[0]}/attendance`;
      const value = {
        enrollment_id: enrollmentId,
        date: "2026-03-02",
        slot: 0,
        status: "present",
      };
      const data = await (await call(`/books/${bookIds[0]}`)).json();
      const revision =
        data.attendance.find(
          (a: any) => a.enrollment_id === enrollmentId && a.date === value.date,
        )?.revision || 0;
      const first = await call(path, { ...value, expected_revision: revision });
      expect(first.status).toBe(200);
      const stale = await call(path, {
        ...value,
        status: "absent",
        expected_revision: revision,
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).code).toBe("REVISION_CONFLICT");
      const cleared = await call(path, {
        ...value,
        status: null,
        expected_revision: revision + 1,
      });
      expect(cleared.status).toBe(200);
      const repeated = await call(path, {
        ...value,
        expected_revision: revision + 1,
      });
      expect(repeated.status).toBe(409);
      const missing = await handleApi(
        new Request(`https://cac.test/api${path}`, {
          method: "POST",
          headers: {
            Origin: "https://cac.test",
            "Content-Type": "application/json",
            Cookie: bookCookie,
          },
          body: JSON.stringify(value),
        }),
        ip,
      );
      expect(missing.status).toBe(400);
      const notePath = `/books/${bookIds[0]}/notes`;
      const student = (
        await (await call(`/books/${bookIds[0]}`)).json()
      ).enrollments.find((e: any) => e.id === enrollmentId);
      expect(
        (
          await call(notePath, {
            enrollment_id: enrollmentId,
            note: "Nueva nota",
            expected_revision: student.note_revision,
          })
        ).status,
      ).toBe(200);
      const conflict = await call(notePath, {
        enrollment_id: enrollmentId,
        note: "Texto obsoleto",
        expected_revision: student.note_revision,
      });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).current.note).toBe("Nueva nota");
    });
    it("archiva sin borrar y bloquea escritura y aprobación hasta restaurar", async () => {
      const proposal = await call(`/books/${bookIds[0]}/requests`, {
        kind: "student.update",
        data: {
          enrollment_id: enrollmentId,
          full_name: "Nombre después de restaurar",
          joined_on: "2026-03-01",
        },
      });
      expect(proposal.status).toBe(202);
      const request = (await proposal.json()).id;
      expect(
        (
          await call(
            "/admin",
            {
              action: "archive",
              entity: "period",
              id: periodId,
              archived: true,
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      const data = await (await call(`/books/${bookIds[0]}`)).json();
      expect(data.can_write).toBe(false);
      expect(
        (
          await call(
            `/books/${bookIds[0]}/notes`,
            { enrollment_id: enrollmentId, note: "No permitido" },
            adminCookie,
          )
        ).status,
      ).toBe(409);
      expect((await call(`/books/${bookIds[0]}/requests`)).status).toBe(200);
      expect(
        (
          await call(
            `/admin/requests/${request}`,
            { decision: "approve", note: "" },
            adminCookie,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            `/books/${bookIds[0]}/export?from=2026-03-01&to=2026-03-31`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            "/admin",
            {
              action: "archive",
              entity: "period",
              id: periodId,
              archived: false,
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            `/admin/requests/${request}`,
            { decision: "approve", note: "" },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            "/admin",
            {
              action: "archive",
              entity: "book",
              id: bookIds[0],
              archived: true,
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await (
            await call(`/books/${bookIds[1]}`, undefined, adminCookie)
          ).json()
        ).can_write,
      ).toBe(true);
      expect(
        (
          await call(
            "/admin",
            {
              action: "archive",
              entity: "book",
              id: bookIds[0],
              archived: false,
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            "/admin",
            {
              action: "archive",
              entity: "teacher",
              id: teacherId,
              archived: true,
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (await (await call(`/books/${bookIds[0]}`)).json()).can_write,
      ).toBe(true);
      expect(
        (
          await call(
            "/books",
            {
              teacher_id: teacherId,
              period_id: periodId,
              discipline: "No crear",
              sessions_per_week: 1,
              password: "123456",
            },
            adminCookie,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            "/admin",
            {
              action: "archive",
              entity: "teacher",
              id: teacherId,
              archived: false,
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
    });
    it("edita entidades y valida límites del período y duración sin cambios parciales", async () => {
      expect(
        (
          await call(
            "/admin",
            {
              action: "edit-teacher",
              id: teacherId,
              name: "Profesor corregido",
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            "/admin",
            {
              action: "edit-book",
              id: bookIds[0],
              discipline: "Disciplina corregida",
              teacher_id: teacherId,
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            "/admin",
            {
              action: "edit-period",
              id: periodId,
              name: "Período corregido",
              start_date: "2026-03-02",
              end_date: "2026-11-30",
            },
            adminCookie,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            "/admin",
            {
              action: "edit-period",
              id: periodId,
              name: "Período corregido",
              start_date: "2026-03-01",
              end_date: "2026-11-30",
            },
            adminCookie,
          )
        ).status,
      ).toBe(200);
      const addition = await call(
        `/books/${bookIds[0]}/students`,
        {
          full_name: "Horario contiguo",
          joined_on: "2026-03-01",
          slots: [{ day: 0, time: "15:45" }],
        },
        adminCookie,
      );
      expect(addition.status).toBe(201);
      expect(
        (
          await call(
            "/admin",
            { action: "duration", book_id: bookIds[0], duration_minutes: 60 },
            adminCookie,
          )
        ).status,
      ).toBe(409);
      expect(
        (await (await call(`/books/${bookIds[0]}`)).json()).book
          .duration_minutes,
      ).toBe(45);
      expect(
        (
          await call(
            "/admin",
            { action: "duration", book_id: bookIds[0], duration_minutes: 45 },
            adminCookie,
          )
        ).status,
      ).toBe(200);
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
      expect((await call(`/books/${bookIds[0]}`)).status).toBe(401);
      const r = await call(
        "/login",
        { kind: "book", book_id: bookIds[0], password: "nuevo-password" },
        "",
      );
      expect(r.status).toBe(200);
      bookCookie = r.headers.get("set-cookie")!.split(";")[0];
    });
    it("rechaza la gestión de la antigua credencial de creación", async () => {
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
      expect((await call(`/books/${bookIds[0]}`)).status).toBe(401);
    });
  },
);
