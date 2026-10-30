import { describe, it, expect, vi, afterEach } from "vitest";
import { performance } from "node:perf_hooks";
import type { BookData } from "../src/domain";
const state = vi.hoisted(() => ({
  access: null as null | { kind: string; book_id: null },
  calls: 0,
  queries: [] as string[],
  count: 0,
  duplicate: false,
}));
vi.mock("../server/db", () => ({
  transaction: async (fn: any) =>
    fn({
      query: async (sql: string) => {
        state.queries.push(sql);
        if (sql.includes("SELECT kind,book_id"))
          return { rows: state.access ? [state.access] : [] };
        if (sql.includes("AS daily"))
          return { rows: [{ daily: state.count, minute: 0 }] };
        if (sql.includes("SELECT 1 FROM maca_requests"))
          return { rows: [], rowCount: state.duplicate ? 1 : 0 };
        if (sql.includes("FROM change_requests"))
          return { rows: [{ pending: 3 }] };
        return { rows: [], rowCount: 0 };
      },
    }),
}));
import {
  analyze,
  privateQuestion,
  dateRange,
  questionRange,
  defaultIntent,
  askMaca,
  macaInput,
} from "../server/maca";
import { handleApi } from "../server/api";
afterEach(() => {
  state.access = null;
  state.queries = [];
  state.count = 0;
  state.duplicate = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const payload = () => ({
  request_id: crypto.randomUUID(),
  question: "Cambios esperando aprobacion hoy",
});
const request = () =>
  new Request("https://cac.test/api/admin/maca", {
    method: "POST",
    headers: {
      origin: "https://cac.test",
      "content-type": "application/json",
      cookie: "cac_session=test",
    },
    body: JSON.stringify(payload()),
  });
it("rechaza anónimos y profesores antes de consumir cuota", async () => {
  expect((await handleApi(request())).status).toBe(401);
  state.access = { kind: "book", book_id: null };
  expect((await handleApi(request())).status).toBe(403);
  expect(state.queries.some((q) => q.includes("maca_requests"))).toBe(false);
});
it("permite administrador y cuenta pendientes con SQL fijo", async () => {
  vi.stubEnv("GEMINI_API_KEY", "");
  state.access = { kind: "admin", book_id: null };
  const response = await handleApi(request());
  expect(response.status).toBe(200);
  expect((await response.json()).text).toContain("3 cambios");
});
it("no permite SQL ni nombres, correos o números en el texto externo", () => {
  expect(
    privateQuestion(
      "Asistencia de María Pérez RUT 12345678 correo maria@example.com; DROP TABLE students; clave SECRETO",
    ),
  ).toBe("asistencia");
  expect(() =>
    macaInput.parse({ ...payload(), sql: "DROP TABLE books" }),
  ).toThrow();
});
it("bloquea cuotas y duplicados antes de invocar Gemini", async () => {
  state.count = 30;
  await expect(askMaca(payload(), "session")).rejects.toMatchObject({
    status: 429,
  });
  state.count = 0;
  state.duplicate = true;
  await expect(askMaca(payload(), "session")).rejects.toMatchObject({
    status: 409,
  });
});
it("envía solo vocabulario y registra uso real de Gemini", async () => {
  vi.stubEnv("GEMINI_API_KEY", "server-secret");
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      metric: "requests",
                      period: "today",
                      compare: false,
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await askMaca(
    { ...payload(), question: "Solicitudes de María Pérez 123456 hoy" },
    "session",
  );
  const sent = JSON.parse((fetch.mock.calls[0] as any)[1].body);
  expect(sent.contents[0].parts[0].text).toBe("solicitudes hoy");
  expect(
    state.queries.some((q) => q.includes("gemini_calls=gemini_calls+1")),
  ).toBe(true);
  expect(state.queries.some((q) => q.includes("input_tokens=$3"))).toBe(true);
});
it("maneja cuota agotada y respuestas maliciosas del modelo", async () => {
  vi.stubEnv("GEMINI_API_KEY", "test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 429 })),
  );
  await expect(askMaca(payload(), "session")).rejects.toMatchObject({
    status: 429,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: '{"sql":"DELETE FROM books"}' }] } },
            ],
          }),
        ),
    ),
  );
  await expect(askMaca(payload(), "session")).rejects.toMatchObject({
    status: 503,
  });
  expect(state.queries.some((q) => q.includes("DELETE FROM books"))).toBe(
    false,
  );
});
it("resuelve períodos administrativos y comparación", () => {
  expect(dateRange(defaultIntent("semana"), "2026-10-30")).toEqual({
    from: "2026-10-26",
    to: "2026-10-30",
  });
  expect(dateRange(defaultIntent("semestre"), "2026-10-30").from).toBe(
    "2026-07-01",
  );
});
it("resuelve fechas y meses sin enviarlos al proveedor", () => {
  expect(
    questionRange(
      "asistencia junio de 2026",
      defaultIntent("asistencia"),
      "2026-10-30",
    ),
  ).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  expect(
    questionRange("asistencia ayer", defaultIntent("asistencia"), "2026-10-30"),
  ).toEqual({ from: "2026-10-29", to: "2026-10-29" });
  expect(
    questionRange(
      "asistencia mes anterior",
      defaultIntent("mes anterior"),
      "2026-10-30",
    ),
  ).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  expect(
    questionRange(
      "2026-03-01 al 2026-04-01",
      defaultIntent("asistencia"),
      "2026-10-30",
    ),
  ).toEqual({ from: "2026-03-01", to: "2026-04-01" });
});
function fixture(i: number): BookData {
  return {
    book: {
      id: "b" + i,
      teacher_id: "t" + i,
      period_id: "p",
      discipline: "Curso",
      sessions_per_week: 1,
      duration_minutes: 45,
    },
    period: {
      id: "p",
      name: "2026",
      start_date: "2026-06-01",
      end_date: "2026-06-30",
    },
    enrollments: Array.from({ length: 22 }, (_, j) => ({
      id: `${i}-${j}`,
      student_id: `${i}-${j}`,
      book_id: "b" + i,
      full_name: "Privado",
      joined_on: "2026-06-01",
      left_on: null,
    })),
    schedules: Array.from({ length: 22 }, (_, j) => ({
      id: `s${i}-${j}`,
      enrollment_id: `${i}-${j}`,
      effective_from: "2026-06-01",
      slots: [{ day: 0, time: "10:00" }],
    })),
    attendance: [
      {
        enrollment_id: `${i}-0`,
        date: "2026-06-01",
        slot: 0,
        status: "present",
      },
      {
        enrollment_id: `${i}-1`,
        date: "2026-06-01",
        slot: 0,
        status: "justified",
      },
      {
        enrollment_id: `${i}-2`,
        date: "2026-06-01",
        slot: 0,
        status: "absent",
      },
    ],
    suspensions: [],
  };
}
it("pendientes no son ausencias y suspensión prevalece sobre marca", () => {
  const book = fixture(0);
  book.suspensions = [
    {
      id: "s",
      scope: "center",
      target_id: null,
      start_date: "2026-06-01",
      end_date: "2026-06-01",
      reason: "Cierre",
    },
  ];
  const result = analyze([book], "2026-06-01", "2026-06-30", "attendance");
  expect(result.summary).toMatchObject({
    suspended: 22,
    pending: 88,
    absent: 0,
    count: 0,
    percentage: null,
  });
});
it("simula 50 profesores y 5500 sesiones mensuales", () => {
  const books = Array.from({ length: 50 }, (_, i) => fixture(i));
  const start = performance.now();
  const result = analyze(books, "2026-06-01", "2026-06-30", "attendance");
  const ms = performance.now() - start;
  expect(result.summary).toMatchObject({
    count: 150,
    pending: 5350,
    present: 50,
    absent: 50,
    justified: 50,
    percentage: 66.7,
  });
  expect(result.teachers).toBe(50);
  console.log(
    `Maca: 5500 sesiones / 50 profesores, ${ms.toFixed(1)} ms; heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MiB (proceso de pruebas, sin red/SQL).`,
  );
  expect(ms).toBeLessThan(5000);
});
