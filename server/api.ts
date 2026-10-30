import { administer } from "./administration";
import { chileHolidays } from "./holidays";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { digest, hashPassword, newToken, verifyPassword } from "./security";
import {
  audit,
  HttpError,
  loadBook,
  visibleBook,
  loadAdminBooks,
  lockBook,
  requireAdmin,
  requireBook,
  requireWritable,
  setAttendance,
  type Access,
} from "./service";
import { lessonsFor, summarize, labels } from "../src/domain";
import ExcelJS from "exceljs";
import { id, name, password, date, slots } from "./validation";
import { applyBookChange, createBook } from "./changes";
import { proposeChange, listRequests, reviewRequest } from "./requests";
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
    return json(
      { error: "Método no permitido.", code: "METHOD_NOT_ALLOWED" },
      405,
    );
  if (req.method === "POST" && req.headers.get("origin") !== url.origin)
    return json(
      { error: "Solicitud de origen no permitido.", code: "FORBIDDEN" },
      403,
    );
  try {
    if (path === "/login" && req.method === "POST") {
      const input = z
        .object({
          kind: z.enum(["admin", "creator", "book"]),
          book_id: id.optional(),
          password: z.string().min(1).max(128),
        })
        .parse(await body(req));
      if (input.kind === "creator")
        throw new HttpError(
          403,
          "Solo administración puede crear libros. Ingresa al panel administrativo.",
        );
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
            code: "RATE_LIMITED",
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
            {
              error: "Contraseña incorrecta. Vuelve a intentarlo.",
              code: "AUTH_INVALID",
            },
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
            "SELECT b.archived_at,p.archived_at AS period_archived_at,b.id,b.teacher_id,b.period_id,b.discipline,b.sessions_per_week,b.duration_minutes,t.name AS teacher_name,p.name AS period_name,p.start_date::text,p.end_date::text FROM books b JOIN teachers t ON t.id=b.teacher_id JOIN periods p ON p.id=b.period_id ORDER BY p.start_date DESC,t.name,b.discipline",
          )
        ).rows;
        const teachers = (
          await c.query(
            "SELECT archived_at,id,name FROM teachers ORDER BY name",
          )
        ).rows;
        const periods = (
          await c.query(
            "SELECT archived_at,id,name,start_date::text,end_date::text FROM periods ORDER BY start_date DESC",
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
        requireAdmin(access);
        return json(await createBook(c, access, await body(req)), 201);
      }
      const adminBookPath = path.match(
        /^\/admin\/books\/([a-f0-9-]+)\/(students|schedule)$/,
      );
      if (adminBookPath && req.method === "POST") {
        requireAdmin(access);
        const raw = await body(req);
        const action = adminBookPath[2] as "students" | "schedule";
        return json(
          await applyBookChange(
            c,
            access,
            id.parse(adminBookPath[1]),
            action,
            raw,
          ),
          action === "students" && !raw?.enrollment_id ? 201 : 200,
        );
      }
      const requestPath = path.match(/^\/books\/([a-f0-9-]+)\/requests$/);
      if (requestPath) {
        const bookId = id.parse(requestPath[1]);
        requireBook(access, bookId);
        if (req.method === "GET")
          return json({ requests: await listRequests(c, access!, bookId) });
        const input = z
          .object({
            kind: z.enum([
              "student.create",
              "student.update",
              "schedule.update",
              "book.create",
            ]),
            data: z.unknown(),
          })
          .parse(await body(req));
        return json(
          await proposeChange(c, access!, bookId, input.kind, input.data),
          202,
        );
      }
      if (path === "/admin/requests") {
        requireAdmin(access);
        return json({ requests: await listRequests(c, access) });
      }
      const reviewPath = path.match(/^\/admin\/requests\/([a-f0-9-]+)$/);
      if (reviewPath && req.method === "POST") {
        requireAdmin(access);
        const input = z
          .object({
            decision: z.enum(["approve", "reject"]),
            note: z.string().trim().max(500).default(""),
          })
          .parse(await body(req));
        return json(
          await reviewRequest(c, access, id.parse(reviewPath[1]), input),
        );
      }
      const bookPath = path.match(
        /^\/books\/([a-f0-9-]+)(?:\/(students|schedule|attendance|export|notes))?$/,
      );
      if (bookPath) {
        const bookId = id.parse(bookPath[1]),
          action = bookPath[2];
        requireBook(access, bookId);
        if (!action && req.method === "GET")
          return json(visibleBook(await loadBook(c, bookId), access!));
        if (action === "notes" && req.method === "POST") {
          const input = z
            .object({
              enrollment_id: id,
              note: z.string().trim().max(500),
              expected_revision: z.number().int().nonnegative(),
              resolve_conflict: z.boolean().optional(),
            })
            .parse(await body(req));
          await lockBook(c, bookId);
          const data = visibleBook(await loadBook(c, bookId), access!);
          requireWritable(data);
          const student = data.enrollments.find(
            (e) => e.id === input.enrollment_id,
          );
          if (!student) throw new HttpError(404, "Estudiante no encontrado.");
          if (student.note_revision !== input.expected_revision)
            throw new HttpError(
              409,
              "Otra sesión modificó esta nota.",
              "REVISION_CONFLICT",
              { revision: student.note_revision, note: student.note },
            );
          await c.query(
            "UPDATE enrollments SET note=$1,note_revision=note_revision+1 WHERE id=$2",
            [input.note, input.enrollment_id],
          );
          await audit(
            c,
            access!,
            input.resolve_conflict
              ? "note.conflict_resolved"
              : "enrollment.note",
            bookId,
            {
              enrollment_id: input.enrollment_id,
              note: input.note,
            },
          );
          return json({ ok: true, revision: input.expected_revision + 1 });
        }
        if (action === "attendance" && req.method === "POST") {
          const input = z
            .object({
              enrollment_id: id,
              date,
              slot: z.number().int().min(0).max(6),
              status: z.enum(["present", "absent", "justified"]).nullable(),
              expected_revision: z.number().int().nonnegative(),
              resolve_conflict: z.boolean().optional(),
            })
            .parse(await body(req));
          return json(await setAttendance(c, access!, bookId, input));
        }
        if (
          (action === "students" || action === "schedule") &&
          req.method === "POST"
        ) {
          const raw = await body(req);
          const kind =
            action === "schedule"
              ? "schedule.update"
              : raw?.enrollment_id
                ? "student.update"
                : "student.create";
          return json(await proposeChange(c, access!, bookId, kind, raw), 202);
        }
        if (action === "export" && req.method === "GET") {
          const from = date.parse(url.searchParams.get("from")),
            to = date.parse(url.searchParams.get("to"));
          if (from > to)
            throw new HttpError(400, "Revisa las fechas del informe.");
          const data = visibleBook(await loadBook(c, bookId), access!),
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
      if (path === "/admin/overview" && req.method === "GET") {
        requireAdmin(access);
        return json({ books: await loadAdminBooks(c) });
      }
      if (path === "/admin" && req.method === "GET") {
        requireAdmin(access);
        const year = z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100)
          .parse(url.searchParams.get("year") || new Date().getUTCFullYear());
        const excluded = new Set<string>(
          (await c.query("SELECT date::text FROM holiday_exceptions")).rows.map(
            (r) => r.date,
          ),
        );
        return json({
          pending_count: Number(
            (
              await c.query(
                "SELECT count(*) FROM change_requests WHERE status='pending'",
              )
            ).rows[0].count,
          ),
          suspensions: [
            ...(
              await c.query(
                "SELECT id,scope,target_id,start_date::text,end_date::text,reason FROM suspensions ORDER BY start_date DESC",
              )
            ).rows.map((s) => ({ ...s, source: "manual", active: true })),
            ...chileHolidays(year).map((h) => ({
              ...h,
              active: !excluded.has(h.start_date),
            })),
          ].sort((a, b) => a.start_date.localeCompare(b.start_date)),
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
            "holiday-exception",
            "password",
            "duration",
            "edit-teacher",
            "edit-period",
            "edit-book",
            "archive",
          ])
          .parse(raw.action);
        if (
          [
            "duration",
            "edit-teacher",
            "edit-period",
            "edit-book",
            "archive",
          ].includes(action)
        ) {
          await administer(c, access, raw);
          return json({ ok: true });
        }
        if (action === "holiday-exception") {
          const input = z
            .object({ date, classes_enabled: z.boolean() })
            .parse(raw);
          if (
            !chileHolidays(Number(input.date.slice(0, 4))).some(
              (h) => h.start_date === input.date,
            )
          )
            throw new HttpError(
              400,
              "Esta fecha no corresponde a un feriado nacional del calendario.",
            );
          await c.query("SELECT id FROM books ORDER BY id FOR UPDATE");
          if (input.classes_enabled)
            await c.query(
              "INSERT INTO holiday_exceptions(date) VALUES($1) ON CONFLICT DO NOTHING",
              [input.date],
            );
          else
            await c.query("DELETE FROM holiday_exceptions WHERE date=$1", [
              input.date,
            ]);
          await audit(c, access, "holiday.exception", null, input);
        }
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
        if (action === "password") {
          const input = z
            .object({
              kind: z.enum(["admin", "book"]),
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
          code: "VALIDATION_ERROR",
        },
        400,
      );
    if (error instanceof HttpError)
      return json(
        { error: error.message, code: error.code, current: error.current },
        error.status,
      );
    const code = (error as { code?: string }).code;
    if (code === "23503")
      return json(
        {
          error: "El profesor o período seleccionado ya no está disponible.",
          code: "REFERENCE_CONFLICT",
        },
        409,
      );
    if (code === "23505")
      return json(
        { error: "Este registro ya existe.", code: "DUPLICATE" },
        409,
      );
    const errorId = randomUUID();
    console.error("CAC API error", {
      errorId,
      code: code || "internal",
      route: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id"),
    });
    return json(
      {
        error:
          "No se pudo completar la operación. Vuelve a intentarlo o consulta el dato actual.",
        code: "SERVER_ERROR",
        error_id: errorId,
      },
      503,
    );
  }
}
