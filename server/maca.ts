import {
  conversationContext,
  smallTalk,
  hasMetric,
  hasPeriod,
  followup,
  providerQuestion,
  inheritIntent,
} from "./maca-conversation";
import {
  classify,
  ProviderError,
  type MacaIntent,
  type Provider,
} from "./maca-provider";
export type { MacaIntent } from "./maca-provider";
import { z } from "zod";
import { transaction } from "./db";
import { HttpError, loadAdminBooks } from "./service";
import {
  addDays,
  lessonsFor,
  localToday,
  monday,
  summarize,
  type BookData,
} from "../src/domain";

export const macaInput = z
  .object({
    request_id: z.uuid(),
    question: z.string().trim().min(1).max(600),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    book_id: z.uuid().optional(),
    teacher_id: z.uuid().optional(),
    context: conversationContext.optional(),
  })
  .strict();
// A strict vocabulary boundary: arbitrary user text, identifiers and numbers NEVER reach an external provider.
const vocabulary = new Set(
  "estudiante estudiantes alumno alumnos falta faltas falto faltaron ausente ausentes ausencia ausencias inasistencia inasistencias ausentismo mas mayor quien ranking asistencia asistencias clases clase profesores profesor registraron registrados registros pendientes pendiente libros libro porcentaje mes mensual semana semanal hoy ayer semestre semestral suspendidas suspendidos suspension suspensiones sesiones sesion cambios horario horarios esperando aprobacion solicitudes superpuestos superpuestas superposiciones conflictos evolucion evoluciono tendencia compara comparar comparalo comparacion anterior pasado pasada attendance teachers pending suspended requests conflicts trend today week month semester".split(
    " ",
  ),
);
export function privateQuestion(question: string) {
  return (
    question
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z]+/g)
      ?.filter((w) => vocabulary.has(w))
      .slice(0, 60)
      .join(" ") || ""
  );
}
function asksStudentAbsences(text: string) {
  return (
    /falt|ausen|inasistencia/.test(text) &&
    /estudiant|alumn|quien|mas|mayor|ranking/.test(text)
  );
}
export function defaultIntent(text: string): MacaIntent {
  return {
    metric: asksStudentAbsences(text)
      ? "absences"
      : /aprobacion|solicitudes|cambios/.test(text)
        ? "requests"
        : /superpuest|conflict|superpos/.test(text)
          ? "conflicts"
          : /evolu|tendencia/.test(text)
            ? "trend"
            : /pendiente/.test(text)
              ? "pending"
              : /suspend|suspension/.test(text)
                ? "suspended"
                : /profesor/.test(text)
                  ? "teachers"
                  : "attendance",
    period: /hoy/.test(text)
      ? "today"
      : /semana/.test(text)
        ? "week"
        : /semestre/.test(text)
          ? "semester"
          : "month",
    compare: /compar/.test(text),
  };
}
export function dateRange(intent: MacaIntent, today = localToday()) {
  const year = today.slice(0, 4),
    month = Number(today.slice(5, 7));
  return {
    from:
      intent.period === "today"
        ? today
        : intent.period === "week"
          ? monday(today)
          : intent.period === "semester"
            ? `${year}-${month <= 6 ? "01" : "07"}-01`
            : today.slice(0, 7) + "-01",
    to: today,
  };
}
/** Date parsing stays local; calendar dates never need to be sent to a provider. */
export function questionRange(
  question: string,
  intent: MacaIntent,
  today = localToday(),
) {
  const text = question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (dates?.length)
    return {
      from: z.iso.date().parse(dates[0]),
      to: z.iso.date().parse(dates[1] || dates[0]),
    };
  if (/\bayer\b/.test(text))
    return { from: addDays(today, -1), to: addDays(today, -1) };
  if (!intent.compare && /semana (pasada|anterior)/.test(text))
    return { from: addDays(monday(today), -7), to: addDays(monday(today), -1) };
  if (!intent.compare && /mes (pasado|anterior)/.test(text)) {
    const end = addDays(today.slice(0, 7) + "-01", -1);
    return { from: end.slice(0, 7) + "-01", to: end };
  }
  const months = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  const index = months.findIndex((m) =>
    new RegExp("\\b" + m + "\\b").test(text),
  );
  if (index >= 0) {
    const year = text.match(/\b20\d{2}\b/)?.[0] || today.slice(0, 4);
    const start = `${year}-${String(index + 1).padStart(2, "0")}-01`;
    const end = addDays(
      new Date(Date.UTC(Number(year), index + 1, 1)).toISOString().slice(0, 10),
      -1,
    );
    return { from: start, to: end > today ? today : end };
  }
  return dateRange(intent, today);
}
function limit(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
export function analyze(
  books: BookData[],
  from: string,
  to: string,
  metric: MacaIntent["metric"],
) {
  const all = books.flatMap((b) =>
    lessonsFor(b, from, to).map((l) => ({
      ...l,
      book_id: b.book.id,
      teacher_id: b.book.teacher_id,
      duration: b.book.duration_minutes,
    })),
  );
  let absenceLeader: { name: string; absent: number; ties: number } | null =
    null;
  const summary = summarize(all);
  const rows: Record<string, string | number | null>[] = [];
  if (metric === "absences") {
    const enrollments = new Map(
      books.flatMap((b) => b.enrollments.map((e) => [e.id, e] as const)),
    );
    const students = new Map<
      string,
      {
        name: string;
        present: number;
        absent: number;
        justified: number;
        pending: number;
        suspended: number;
      }
    >();
    for (const lesson of all) {
      const e = enrollments.get(lesson.enrollment_id);
      if (!e) continue;
      const student = students.get(e.student_id) || {
        name: e.full_name,
        present: 0,
        absent: 0,
        justified: 0,
        pending: 0,
        suspended: 0,
      };
      student[lesson.status]++;
      students.set(e.student_id, student);
    }
    const ranked = [...students.values()]
      .filter((s) => s.absent > 0)
      .sort(
        (a, b) => b.absent - a.absent || a.name.localeCompare(b.name, "es"),
      );
    if (ranked.length)
      absenceLeader = {
        name: ranked[0].name,
        absent: ranked[0].absent,
        ties: ranked.filter((s) => s.absent === ranked[0].absent).length,
      };
    for (const student of ranked)
      rows.push({
        Estudiante: student.name,
        Ausencias: student.absent,
        Justificadas: student.justified,
        Pendientes: student.pending,
        Suspendidas: student.suspended,
      });
  }
  if (metric === "pending")
    for (const b of books) {
      const pending = all.filter(
        (l) => l.book_id === b.book.id && l.status === "pending",
      ).length;
      if (pending)
        rows.push({
          Libro: b.book.discipline,
          Profesor: b.book.teacher_name || b.book.teacher_id,
          Pendientes: pending,
        });
    }
  if (metric === "trend")
    for (const month of [
      ...new Set(all.map((l) => l.date.slice(0, 7))),
    ].sort()) {
      const s = summarize(all.filter((l) => l.date.startsWith(month)));
      rows.push({
        Mes: month,
        Registradas: s.count,
        Pendientes: s.pending,
        "Asistencia %": s.percentage,
      });
    }
  let conflicts = 0;
  if (metric === "conflicts") {
    const groups = new Map<string, typeof all>();
    for (const l of all) {
      const key = l.teacher_id + "/" + l.date;
      const group = groups.get(key) || [];
      group.push(l);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.time.localeCompare(b.time));
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i],
            b = group[j];
          const minutes = (t: string) =>
            Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
          if (minutes(b.time) >= minutes(a.time) + a.duration) break;
          conflicts++;
          if (rows.length < 100)
            rows.push({ Fecha: a.date, Hora: a.time, "Otra hora": b.time });
        }
    }
  }
  return {
    summary,
    absenceLeader,
    teachers: new Set(
      all
        .filter((l) => ["present", "absent", "justified"].includes(l.status))
        .map((l) => l.teacher_id),
    ).size,
    conflicts,
    rows: rows.slice(0, 100),
    truncated: rows.length > 100,
  };
}
const cache = new Map<
  string,
  { expires: number; value: ReturnType<typeof analyze> }
>();
export async function askMaca(raw: unknown, sessionHash: string) {
  const input = macaInput.parse(raw);
  const day = localToday();
  const daily = limit("MACA_DAILY_LIMIT", 30, 1000),
    minute = limit("MACA_MINUTE_LIMIT", 6, 60);
  const usage = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(483722)");
    await c.query(
      "DELETE FROM maca_requests WHERE created_at < now()-interval '32 days'",
    );
    const counts = (
      await c.query(
        `SELECT count(*) FILTER(WHERE (created_at AT TIME ZONE 'America/Santiago')::date=$1::date)::int AS daily,count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS minute FROM maca_requests WHERE created_at>now()-interval '2 days'`,
        [day],
      )
    ).rows[0];
    if (
      (
        await c.query(
          "SELECT 1 FROM maca_requests WHERE session_hash=$1 AND request_id=$2",
          [sessionHash, input.request_id],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "Esta pregunta ya fue recibida.",
        "MACA_DUPLICATE",
      );
    if (counts.daily >= daily || counts.minute >= minute)
      throw new HttpError(
        429,
        "Límite de Maca alcanzado. Espera antes de volver a consultar.",
        "MACA_LIMIT",
      );
    await c.query(
      "INSERT INTO maca_requests(session_hash,request_id) VALUES($1,$2)",
      [sessionHash, input.request_id],
    );
    return { used: counts.daily + 1, limit: daily };
  });
  let outcome = "error";
  try {
    const safe = privateQuestion(input.question);
    const chatReply = smallTalk(input.question);
    const isFollowup = followup(input.question, safe, input.context);
    const conversationalText =
      chatReply ||
      (!hasMetric(safe) && !isFollowup
        ? hasPeriod(input.question)
          ? "¿Qué quieres revisar en ese período: asistencia, ausencias o pendientes?"
          : "Te ayudo con los datos del CAC. ¿Quieres revisar asistencia, quién falta más o algún cambio de horario? Si hablas de un libro o profesor, puedes elegirlo en Filtros."
        : null);
    if (conversationalText) {
      outcome = "ok";
      return {
        kind: "conversation" as const,
        fallback: null,
        text: conversationalText,
        rows: [],
        source: "Maca",
        usage,
        generated_at: new Date().toISOString(),
        context: input.context || null,
      };
    }
    let intent = isFollowup
        ? inheritIntent(defaultIntent(safe), input.context!)
        : defaultIntent(safe),
      source = "Interpretación interna";
    const provider = process.env.MACA_PROVIDER || "gemini";
    if (!["gemini", "groq", "internal"].includes(provider))
      throw new HttpError(503, "Proveedor de Maca no configurado.");
    // Rankings with student identities are resolved entirely inside the server.
    const localRanking = intent.metric === "absences";
    if (localRanking) source = "Análisis interno · ausencias por estudiante";
    const key = localRanking
      ? undefined
      : provider === "groq"
        ? process.env.GROQ_API_KEY
        : provider === "gemini"
          ? process.env.GEMINI_API_KEY
          : undefined;
    let fallback: string | null = null;
    if (key) {
      // Static statements: provider/model output never becomes SQL.
      await transaction((c) =>
        c.query(
          provider === "groq"
            ? "UPDATE maca_requests SET groq_calls=groq_calls+1,provider='groq' WHERE session_hash=$1 AND request_id=$2"
            : "UPDATE maca_requests SET gemini_calls=gemini_calls+1,provider='gemini' WHERE session_hash=$1 AND request_id=$2",
          [sessionHash, input.request_id],
        ),
      );
      let classified: Awaited<ReturnType<typeof classify>> | undefined;
      try {
        classified = await classify(
          provider as Provider,
          providerQuestion(safe, isFollowup ? input.context : undefined),
        );
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        fallback = error.reason;
      }
      if (classified) {
        await transaction((c) =>
          c.query(
            "UPDATE maca_requests SET input_tokens=$3,output_tokens=$4 WHERE session_hash=$1 AND request_id=$2",
            [
              sessionHash,
              input.request_id,
              classified.usage.input,
              classified.usage.output,
            ],
          ),
        );
        if (classified.intent) {
          intent = isFollowup
            ? inheritIntent(classified.intent, input.context!)
            : classified.intent;
          // Unambiguous institutional concepts take precedence over model synonyms.
          if (/aprobacion|solicitudes|cambios/.test(safe))
            intent.metric = "requests";
          else if (/superpuest|conflict|superpos/.test(safe))
            intent.metric = "conflicts";
          else if (/evolu|tendencia/.test(safe)) intent.metric = "trend";
          source = `${provider === "groq" ? "Groq" : "Gemini"} · clasificación sin datos personales`;
        } else fallback = "invalid_response";
      }
    } else if (provider !== "internal" && !localRanking)
      fallback = "missing_key";
    if (fallback) {
      const reasons: Record<string, string> = {
        quota: "cuota del proveedor agotada",
        payment: "proveedor bloqueado por créditos",
        credentials: "clave o permisos del proveedor",
        unavailable: "proveedor no disponible",
        invalid_response: "respuesta del proveedor no válida",
        missing_key: "sin clave del proveedor",
      };
      source = `Interpretación interna · respaldo (${reasons[fallback]})`;
      await transaction((c) =>
        c.query(
          "UPDATE maca_requests SET fallback_reason=$3 WHERE session_hash=$1 AND request_id=$2",
          [sessionHash, input.request_id, fallback],
        ),
      );
    }
    const range =
      !hasPeriod(input.question) && input.context
        ? { from: input.context.from, to: input.context.to }
        : questionRange(input.question, intent);
    const from = input.from || range.from,
      to = input.to || range.to;
    if (
      from > to ||
      to > day ||
      new Date(to).getTime() - new Date(from).getTime() > 366 * 86400000
    )
      throw new HttpError(400, "Selecciona un rango pasado de hasta 366 días.");
    const days =
      Math.round(
        (new Date(to).getTime() - new Date(from).getTime()) / 86400000,
      ) + 1;
    const previous = { from: addDays(from, -days), to: addDays(from, -1) };
    const result = await transaction(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      );
      await c.query("SET LOCAL statement_timeout='8s'");
      if (intent.metric === "requests") {
        const row = (
          await c.query(
            `SELECT count(*)::int AS pending FROM change_requests r JOIN books b ON b.id=r.book_id WHERE r.kind='schedule.update' AND r.status='pending' AND ($1::uuid IS NULL OR b.id=$1) AND ($2::uuid IS NULL OR b.teacher_id=$2)`,
            [input.book_id || null, input.teacher_id || null],
          )
        ).rows[0];
        return {
          text:
            Number(row.pending) === 0
              ? "La bandeja está en silencio: no hay cambios de horario esperando aprobación en este momento."
              : `Hay ${row.pending} cambios de horario esperando aprobación en este momento; todavía esperan la batuta de administración.`,
          rows: [],
          comparison: null,
        };
      }
      const size = (
        await c.query(
          "SELECT (SELECT count(*) FROM enrollments)::int AS enrollments,(SELECT count(*) FROM lessons)::int AS lessons,(SELECT count(*) FROM books)::int AS books",
        )
      ).rows[0];
      if (size.enrollments > 10000 || size.lessons > 150000 || size.books > 300)
        throw new HttpError(
          422,
          "El volumen supera el límite de análisis de esta versión.",
        );
      const key = JSON.stringify([
        intent.metric,
        from,
        to,
        input.book_id,
        input.teacher_id,
      ]);
      let value =
        cache.get(key)?.expires! > Date.now()
          ? cache.get(key)!.value
          : undefined;
      let books: BookData[] = [];
      if (!value || intent.compare)
        books = (await loadAdminBooks(c)).filter(
          (b) =>
            (!input.book_id || b.book.id === input.book_id) &&
            (!input.teacher_id || b.book.teacher_id === input.teacher_id),
        );
      if (!value) {
        value = analyze(books, from, to, intent.metric);
        if (cache.size >= 50) cache.clear();
        cache.set(key, { expires: Date.now() + 30000, value });
      }
      const s = value.summary;
      const figures = `${s.count} sesiones individuales con asistencia registrada: ${s.present} presentes, ${s.absent} ausentes y ${s.justified} justificadas. Asistencia: ${s.percentage === null ? "sin registros" : s.percentage + " %"}.`;
      const text =
        intent.metric === "absences"
          ? value.absenceLeader
            ? value.absenceLeader.ties > 1
              ? `Hay un empate: ${value.absenceLeader.ties} estudiantes tienen ${value.absenceLeader.absent} ausencias cada uno, la mayor cantidad del período consultado. Te dejo el detalle. Solo cuento ausencias registradas; pendientes, justificadas y suspensiones van por separado.`
              : `${value.absenceLeader.name} tiene la mayor cantidad de ausencias registradas en el período consultado: ${value.absenceLeader.absent}. Pendientes, justificadas y suspensiones van por separado. Puedes revisar el detalle en la tabla.`
            : s.count === 0
              ? "No hay asistencias registradas en el período consultado para identificar quién tiene más ausencias. Los registros pendientes no son faltas."
              : "No hay ausencias registradas en el período consultado. Los registros pendientes no se cuentan como faltas."
          : intent.metric === "teachers"
            ? `En la partitura del período aparecen ${value.teachers} profesores con registros de asistencia. Esto cuenta profesores con marcas, no quién las ingresó.`
            : intent.metric === "suspended"
              ? `En la partitura del período figuran ${s.suspended} sesiones individuales suspendidas. Las dejo fuera del porcentaje de asistencia: una pausa institucional no es una ausencia.`
              : intent.metric === "conflicts"
                ? value.conflicts
                  ? `Aquí se cruzaron los compases: detecté ${value.conflicts} pares de sesiones con horarios superpuestos del mismo profesor. Te dejo el detalle para revisarlos.`
                  : "Revisé los compases: no encontré pares de sesiones con horarios superpuestos del mismo profesor en este período."
                : intent.metric === "pending"
                  ? `Revisé la partitura del período: hay ${s.pending} sesiones individuales pendientes de registro. Todavía les falta su nota en el libro; pendiente no significa ausencia.`
                  : intent.metric === "trend"
                    ? `Así va el ritmo de la asistencia: ${figures} En la tabla puedes seguirlo mes a mes.`
                    : `Vamos con los números: ${figures}`;
      return {
        text:
          intent.metric === "absences" ? `Del ${from} al ${to}: ${text}` : text,
        rows: value.rows,
        summary: s,
        comparison: intent.compare
          ? {
              ...previous,
              ...analyze(books, previous.from, previous.to, intent.metric)
                .summary,
            }
          : null,
      };
    });
    outcome = "ok";
    return {
      ...result,
      kind: "analysis" as const,
      context: { metric: intent.metric, from, to },
      from,
      to,
      metric: intent.metric,
      source,
      fallback,
      usage,
      generated_at: new Date().toISOString(),
      filters: {
        book_id: input.book_id || null,
        teacher_id: input.teacher_id || null,
      },
      warning:
        "Pendiente no significa ausencia. Se excluyen suspensiones del porcentaje; las justificadas cuentan como asistencia según la regla vigente. Sesión = una clase individual de un estudiante. Caché: hasta 30 segundos. Tablas: máximo 100 filas. Los filtros se aplican con los selectores; los nombres escritos en el chat no se interpretan.",
    };
  } finally {
    await transaction((c) =>
      c.query(
        "UPDATE maca_requests SET outcome=$3 WHERE session_hash=$1 AND request_id=$2",
        [sessionHash, input.request_id, outcome],
      ),
    );
  }
}
