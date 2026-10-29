import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { digest, hashPassword, newToken, verifyPassword } from "./security";
import {
  audit,
  HttpError,
  loadBook,
  lockBook,
  requireAdmin,
  requireBook,
  setAttendance,
  type Access,
} from "./service";
import { lessonsFor, summarize, labels } from "../src/domain";
import ExcelJS from "exceljs";
const id = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const password = z.string().min(6, "Usa al menos 6 caracteres.").max(128);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T12:00:00Z");
    return !isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, "Fecha inválida.");
const slot = z.object({
  day: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
const slots = z
  .array(slot)
  .min(1)
  .max(7)
  .refine(
    (v) => new Set(v.map((s) => `${s.day}/${s.time}`)).size === v.length,
    "No repitas el mismo día y hora.",
  );
const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
const cookieName = "cac_session";
function cookie(token: string, req: Request, maxAge = 43200) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;
}
async function accessFrom(
  c: import("@neondatabase/serverless").PoolClient,
  req: Request,
): Promise<Access | null> {
  const token = (req.headers.get("cookie") || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  if (!token) return null;
  return (
    (
      await c.query(
        "SELECT kind,book_id FROM access_sessions WHERE token_hash=$1 AND expires_at>now()",
        [digest(token)],
      )
    ).rows[0] || null
  );
}
async function body(req: Request) {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "Usa contenido JSON.");
  const text = await req.text();
  if (text.length > 32000)
    throw new HttpError(413, "Formulario demasiado grande.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Formulario inválido.");
  }
}
export async function handleApi(
  req: Request,
  clientIP = "local",
): Promise<Response> {
  const url = new URL(req.url);
  const path =
    url.pathname
      .replace(/^\/\.netlify\/functions\/api/, "")
      .replace(/^\/api/, "") || "/";
  if (!["GET", "POST"].includes(req.method))
    return json({ error: "Método no permitido." }, 405);
  if (req.method === "POST" && req.headers.get("origin") !== url.origin)
    return json({ error: "Solicitud de origen no permitido." }, 403);
  try {
    if (path === "/login" && req.method === "POST") {
      const input = z
        .object({
          kind: z.enum(["admin", "creator", "book"]),
          book_id: id.optional(),
          password: z.string().min(1).max(128),
        })
        .parse(await body(req));
      if (input.kind === "book" && !input.book_id)
        throw new HttpError(400, "Selecciona un libro.");
      // Attempt counters commit independently so failed authentication cannot roll them back.
      const targetKey = digest(
          `${clientIP}/${input.kind}/${input.book_id || ""}`,
        ),
        globalKey = digest(`${clientIP}/all`);
      const blocked = await transaction(async (c) => {
        let blocked = false;
        for (const [key, limit] of [
          [globalKey, 100],
          [targetKey, 15],
        ] as const) {
          const row = (
            await c.query(
              `INSERT INTO login_limits(key_hash,attempts,window_start) VALUES($1,1,now()) ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN login_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE login_limits.attempts+1 END,window_start=CASE WHEN login_limits.window_start < now()-interval '15 minutes' THEN now() ELSE login_limits.window_start END RETURNING attempts`,
              [key],
            )
          ).rows[0];
          if (row.attempts > limit) blocked = true;
        }
        return blocked;
      });
      if (blocked)
        return json(
          {
            error:
              "Demasiados intentos. Espera 15 minutos antes de volver a intentar.",
          },
          429,
          { "Retry-After": "900" },
        );
      return await transaction(async (c) => {
        let encoded: string | undefined;
        if (input.kind === "book")
          encoded = (
            await c.query("SELECT password_hash FROM books WHERE id=$1", [
              input.book_id,
            ])
          ).rows[0]?.password_hash;
        else
          encoded = (
            await c.query(
              "SELECT password_hash FROM access_keys WHERE kind=$1",
              [input.kind],
            )
          ).rows[0]?.password_hash;
        let kind: Access["kind"] = input.kind;
        let valid = await verifyPassword(
          input.password,
          encoded || "scrypt:dummy:" + "00".repeat(64),
        );
        if (!valid && input.kind === "book") {
          const admin = (
            await c.query(
              "SELECT password_hash FROM access_keys WHERE kind='admin'",
            )
          ).rows[0]?.password_hash;
          valid = await verifyPassword(
            input.password,
            admin || "scrypt:dummy:" + "00".repeat(64),
          );
          if (valid) kind = "admin";
        }
        if (!valid)
          return json(
            { error: "Contraseña incorrecta. Vuelve a intentarlo." },
            401,
          );
        await c.query("DELETE FROM login_limits WHERE key_hash=$1", [
          targetKey,
        ]);
        await c.query("DELETE FROM access_sessions WHERE expires_at<now()");
        const token = newToken();
        const bookId = kind === "book" ? input.book_id! : null;
        await c.query(
          "INSERT INTO access_sessions(token_hash,kind,book_id,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
          [digest(token), kind, bookId],
        );
        await audit(c, { kind, book_id: bookId }, "access.login", bookId, {});
        return json({ kind, book_id: bookId }, 200, {
          "Set-Cookie": cookie(token, req),
        });
      });
    }
    return await transaction(async (c) => {
      const access = await accessFrom(c, req);
      if (path === "/session") return json(access);
      if (path === "/logout" && req.method === "POST") {
        const token = (req.headers.get("cookie") || "")
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith(cookieName + "="))
          ?.slice(cookieName.length + 1);
        if (token)
          await c.query("DELETE FROM access_sessions WHERE token_hash=$1", [
            digest(token),
          ]);
        return json({ ok: true }, 200, { "Set-Cookie": cookie("", req, 0) });
      }
      if (path === "/catalog" && req.method === "GET") {
        const books = (
          await c.query(
            "SELECT b.id,b.teacher_id,b.period_id,b.discipline,b.sessions_per_week,b.duration_minutes,t.name AS teacher_name,p.name AS period_name,p.start_date::text,p.end_date::text FROM books b JOIN teachers t ON t.id=b.teacher_id JOIN periods p ON p.id=b.period_id ORDER BY p.start_date DESC,t.name,b.discipline",
          )
        ).rows;
        const teachers = (
          await c.query("SELECT id,name FROM teachers ORDER BY name")
        ).rows;
        const periods = (
          await c.query(
            "SELECT id,name,start_date::text,end_date::text FROM periods ORDER BY start_date DESC",
          )
        ).rows;
        return json({
          books,
          teachers,
          periods,
          environment:
            process.env.APP_ENV === "preview"
              ? "preview"
              : process.env.APP_ENV === "development"
                ? "development"
                : "production",
        });
      }
      if (path === "/books" && req.method === "POST") {
        if (!access || !["creator", "admin"].includes(access.kind))
          throw new HttpError(
            403,
            "Necesitas la contraseña para crear libros.",
          );
        const input = z
          .object({
            teacher_id: id,
            period_id: id,
            discipline: name,
            sessions_per_week: z.number().int().min(1).max(7),
            password,
          })
          .parse(await body(req));
        const bookId = randomUUID();
        await c.query(
          "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
          [
            bookId,
            input.teacher_id,
            input.period_id,
            input.discipline,
            input.sessions_per_week,
            await hashPassword(input.password),
          ],
        );
        await audit(c, access, "book.create", bookId, {
          teacher_id: input.teacher_id,
          discipline: input.discipline,
        });
        return json({ id: bookId }, 201);
      }
      const bookPath = path.match(
        /^\/books\/([a-f0-9-]+)(?:\/(students|schedule|attendance|export))?$/,
      );
      if (bookPath) {
        const bookId = id.parse(bookPath[1]),
          action = bookPath[2];
        requireBook(access, bookId);
        if (!action && req.method === "GET")
          return json(await loadBook(c, bookId));
        if (action === "attendance" && req.method === "POST") {
          const input = z
            .object({
              enrollment_id: id,
              date,
              slot: z.number().int().min(0).max(6),
              status: z.enum(["present", "absent", "justified"]).nullable(),
            })
            .parse(await body(req));
          await setAttendance(c, access!, bookId, input);
          return json({ ok: true });
        }
        if (action === "students" && req.method === "POST") {
          const input = z
            .object({
              enrollment_id: id.optional(),
              student_id: id.optional(),
              full_name: name,
              joined_on: date,
              left_on: date.nullable().optional(),
              slots: slots.optional(),
            })
            .parse(await body(req));
          await lockBook(c, bookId);
          const data = await loadBook(c, bookId);
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
            const e = data.enrollments.find(
              (e) => e.id === input.enrollment_id,
            );
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
            await c.query("UPDATE enrollments SET left_on=$1 WHERE id=$2", [
              input.left_on || null,
              e.id,
            ]);
            await audit(c, access!, "enrollment.update", bookId, {
              enrollment_id: e.id,
              full_name: input.full_name,
              left_on: input.left_on || null,
            });
            return json({ id: e.id });
          }
          if (
            !input.slots ||
            input.slots.length !== data.book.sessions_per_week
          )
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
              throw new HttpError(
                403,
                "No tienes acceso a esa ficha de estudiante.",
              );
            if (
              !(
                await c.query("SELECT id FROM students WHERE id=$1", [
                  studentId,
                ])
              ).rowCount
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
            [
              enrollmentId,
              studentId,
              bookId,
              input.joined_on,
              input.left_on || null,
            ],
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
          return json({ id: enrollmentId }, 201);
        }
        if (action === "schedule" && req.method === "POST") {
          const input = z
            .object({ enrollment_id: id, effective_from: date, slots })
            .parse(await body(req));
          await lockBook(c, bookId);
          const data = await loadBook(c, bookId);
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
            [
              randomUUID(),
              e.id,
              input.effective_from,
              JSON.stringify(input.slots),
            ],
          );
          await audit(c, access!, "schedule.set", bookId, input);
          return json({ ok: true });
        }
        if (action === "export" && req.method === "GET") {
          const from = date.parse(url.searchParams.get("from")),
            to = date.parse(url.searchParams.get("to"));
          if (from > to)
            throw new HttpError(400, "Revisa las fechas del informe.");
          const data = await loadBook(c, bookId),
            all = lessonsFor(data, from, to);
          const workbook = new ExcelJS.Workbook();
          workbook.creator = "Centro Artístico CAC";
          const summary = workbook.addWorksheet("Resumen");
          summary.addRow([
            data.book.discipline,
            data.book.teacher_name,
            from,
            to,
          ]);
          summary.addRow([
            "Estudiante",
            "Presentes",
            "Ausentes",
            "Justificadas",
            "Pendientes",
            "Suspendidas",
            "Asistencia (%)",
          ]);
          for (const e of data.enrollments) {
            const s = summarize(all.filter((l) => l.enrollment_id === e.id));
            summary.addRow([
              e.full_name,
              s.present,
              s.absent,
              s.justified,
              s.pending,
              s.suspended,
              s.percentage ?? "Sin registros",
            ]);
          }
          const total = summarize(all);
          summary.addRow([
            "TOTAL",
            total.present,
            total.absent,
            total.justified,
            total.pending,
            total.suspended,
            total.percentage ?? "Sin registros",
          ]);
          const detail = workbook.addWorksheet("Sesiones");
          detail.addRow([
            "Estudiante",
            "Fecha",
            "Sesión",
            "Hora",
            "Estado",
            "Motivo de suspensión",
          ]);
          for (const l of all)
            detail.addRow([
              data.enrollments.find((e) => e.id === l.enrollment_id)!.full_name,
              l.date,
              l.slot + 1,
              l.time,
              labels[l.status],
              l.reason || "",
            ]);
          for (const sheet of [summary, detail]) {
            sheet.views = [
              { state: "frozen", ySplit: sheet === summary ? 2 : 1 },
            ];
            sheet.columns.forEach((col, i) => {
              col.width = i === 0 ? 36 : 23;
            });
            const header = sheet.getRow(sheet === summary ? 2 : 1);
            header.font = { bold: true, color: { argb: "FFFFFFFF" } };
            header.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FF182039" },
            };
          }
          const buffer = await workbook.xlsx.writeBuffer();
          return new Response(new Uint8Array(buffer), {
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "Content-Disposition":
                'attachment; filename="asistencia-cac.xlsx"',
              "Cache-Control": "no-store",
            },
          });
        }
      }
      if (path === "/admin" && req.method === "GET") {
        requireAdmin(access);
        return json({
          suspensions: (
            await c.query(
              "SELECT id,scope,target_id,start_date::text,end_date::text,reason FROM suspensions ORDER BY start_date DESC",
            )
          ).rows,
          students: (
            await c.query(
              "SELECT id,full_name FROM students ORDER BY full_name",
            )
          ).rows,
        });
      }
      if (path === "/admin" && req.method === "POST") {
        requireAdmin(access);
        const raw = await body(req);
        const action = z
          .enum([
            "teacher",
            "period",
            "suspension",
            "remove-suspension",
            "password",
            "duration",
          ])
          .parse(raw.action);
        if (action === "teacher") {
          const input = z.object({ name }).parse(raw);
          const teacherId = randomUUID();
          await c.query("INSERT INTO teachers(id,name) VALUES($1,$2)", [
            teacherId,
            input.name,
          ]);
          await audit(c, access, "teacher.create", null, input);
        }
        if (action === "period") {
          const input = z
            .object({ name, start_date: date, end_date: date })
            .refine(
              (v) =>
                v.end_date >= v.start_date &&
                (Date.parse(v.end_date) - Date.parse(v.start_date)) /
                  86400000 <=
                  730,
              "El período debe durar como máximo dos años y tener fechas en orden.",
            )
            .parse(raw);
          await c.query(
            "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,$2,$3,$4)",
            [randomUUID(), input.name, input.start_date, input.end_date],
          );
          await audit(c, access, "period.create", null, input);
        }
        if (action === "suspension") {
          const input = z
            .object({
              scope: z.enum(["center", "teacher", "book"]),
              target_id: id.nullable(),
              start_date: date,
              end_date: date,
              reason: name,
            })
            .refine((v) => v.end_date >= v.start_date, "Revisa las fechas.")
            .refine(
              (v) => (v.scope === "center") === (v.target_id === null),
              "Selecciona a quién afecta.",
            )
            .parse(raw);
          if (
            input.scope === "teacher" &&
            !(
              await c.query("SELECT id FROM teachers WHERE id=$1", [
                input.target_id,
              ])
            ).rowCount
          )
            throw new HttpError(404, "Profesor no encontrado.");
          if (
            input.scope === "book" &&
            !(
              await c.query("SELECT id FROM books WHERE id=$1", [
                input.target_id,
              ])
            ).rowCount
          )
            throw new HttpError(404, "Libro no encontrado.");
          await c.query("SELECT id FROM books ORDER BY id FOR UPDATE");
          await c.query(
            "INSERT INTO suspensions(id,scope,target_id,start_date,end_date,reason) VALUES($1,$2,$3,$4,$5,$6)",
            [
              randomUUID(),
              input.scope,
              input.target_id,
              input.start_date,
              input.end_date,
              input.reason,
            ],
          );
          await audit(c, access, "suspension.create", null, input);
        }
        if (action === "remove-suspension") {
          const input = z.object({ id }).parse(raw);
          await c.query("SELECT id FROM books ORDER BY id FOR UPDATE");
          const removed = (
            await c.query("DELETE FROM suspensions WHERE id=$1 RETURNING *", [
              input.id,
            ])
          ).rows[0];
          if (!removed) throw new HttpError(404, "Suspensión no encontrada.");
          await audit(c, access, "suspension.remove", null, removed);
        }
        if (action === "duration") {
          const input = z
            .object({
              book_id: id,
              duration_minutes: z.number().int().min(5).max(480),
            })
            .parse(raw);
          await lockBook(c, input.book_id);
          await c.query("UPDATE books SET duration_minutes=$1 WHERE id=$2", [
            input.duration_minutes,
            input.book_id,
          ]);
          await audit(c, access, "book.duration", input.book_id, input);
        }
        if (action === "password") {
          const input = z
            .object({
              kind: z.enum(["admin", "creator", "book"]),
              book_id: id.optional(),
              password,
            })
            .parse(raw);
          if (input.kind === "book") {
            if (!input.book_id)
              throw new HttpError(400, "Selecciona un libro.");
            await lockBook(c, input.book_id);
            await c.query("UPDATE books SET password_hash=$1 WHERE id=$2", [
              await hashPassword(input.password),
              input.book_id,
            ]);
            await c.query(
              "DELETE FROM access_sessions WHERE kind='book' AND book_id=$1",
              [input.book_id],
            );
          } else {
            const other = input.kind === "admin" ? "creator" : "admin";
            const existing = (
              await c.query(
                "SELECT password_hash FROM access_keys WHERE kind=$1 FOR UPDATE",
                [other],
              )
            ).rows[0];
            if (
              existing &&
              (await verifyPassword(input.password, existing.password_hash))
            )
              throw new HttpError(
                400,
                "Las contraseñas de administración y creación deben ser distintas.",
              );
            await c.query(
              "INSERT INTO access_keys(kind,password_hash) VALUES($1,$2) ON CONFLICT(kind) DO UPDATE SET password_hash=EXCLUDED.password_hash",
              [input.kind, await hashPassword(input.password)],
            );
            await c.query("DELETE FROM access_sessions WHERE kind=$1", [
              input.kind,
            ]);
          }
          await audit(c, access, "password.reset", input.book_id || null, {
            kind: input.kind,
          });
        }
        return json({ ok: true });
      }
      throw new HttpError(404, "No encontramos esta operación.");
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: error.issues[0]?.message || "Revisa los datos del formulario.",
        },
        400,
      );
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    const code = (error as { code?: string }).code;
    if (code === "23503")
      return json(
        { error: "El profesor o período seleccionado ya no está disponible." },
        409,
      );
    if (code === "23505")
      return json({ error: "Este registro ya existe." }, 409);
    console.error("CAC API error", { code: code || "internal", path });
    return json(
      {
        error:
          "No se pudo completar la operación. Tus cambios no se confirmaron; vuelve a intentarlo.",
      },
      503,
    );
  }
}
