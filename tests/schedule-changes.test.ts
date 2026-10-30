import { it, expect, vi } from "vitest";
import type { BookData } from "../src/domain";
const { loadBook } = vi.hoisted(() => ({ loadBook: vi.fn() }));
vi.mock("../server/service", () => ({
  loadBook,
  visibleBook: (data: BookData) => data,
  requireAdmin: vi.fn(),
  requireWritable: vi.fn(),
  lockBook: vi.fn(),
  audit: vi.fn(),
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { applyBookChange } from "../server/changes";
const enrollment = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture(): BookData {
  return {
    book: {
      id: "book",
      teacher_id: "teacher",
      period_id: "period",
      discipline: "Piano",
      duration_minutes: 45,
      sessions_per_week: 1,
    },
    period: {
      id: "period",
      name: "2026",
      start_date: "2026-03-01",
      end_date: "2026-11-30",
    },
    enrollments: [
      {
        id: "other",
        student_id: "other",
        book_id: "book",
        full_name: "Otro alumno",
        joined_on: "2026-03-01",
        left_on: null,
      },
      {
        id: enrollment,
        student_id: "student",
        book_id: "book",
        full_name: "Alumno",
        joined_on: "2026-03-01",
        left_on: null,
      },
    ],
    schedules: [
      {
        id: "other",
        enrollment_id: "other",
        effective_from: "2026-03-01",
        slots: [{ day: 0, time: "14:00" }],
      },
      {
        id: "initial",
        enrollment_id: enrollment,
        effective_from: "2026-03-01",
        slots: [{ day: 1, time: "14:00" }],
      },
      {
        id: "future",
        enrollment_id: enrollment,
        effective_from: "2026-07-01",
        slots: [{ day: 0, time: "14:00" }],
      },
    ],
    attendance: [],
    suspensions: [],
  };
}
it("guarda un horario libre sin bloquear por una versión futura que no cambia", async () => {
  loadBook.mockResolvedValue(fixture());
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  await expect(
    applyBookChange(
      { query } as any,
      { kind: "admin", book_id: null },
      "book",
      "schedule",
      {
        enrollment_id: enrollment,
        effective_from: "2026-06-01",
        slots: [{ day: 0, time: "14:45" }],
      },
    ),
  ).resolves.toEqual({ ok: true });
  expect(
    query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO schedule_versions"),
    ),
  ).toBe(true);
});
it("rechaza un cruce dentro de la vigencia editada sin escribir el horario", async () => {
  loadBook.mockResolvedValue(fixture());
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  await expect(
    applyBookChange(
      { query } as any,
      { kind: "admin", book_id: null },
      "book",
      "schedule",
      {
        enrollment_id: enrollment,
        effective_from: "2026-06-01",
        slots: [{ day: 0, time: "14:30" }],
      },
    ),
  ).rejects.toThrow("14:00–14:45, Otro alumno");
  expect(
    query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO schedule_versions"),
    ),
  ).toBe(false);
});

it("reincorporar valida desde el día posterior al último día de matrícula", async () => {
  const data = fixture();
  data.schedules = data.schedules.slice(0, 2);
  data.schedules[1].slots[0].day = 0;
  data.enrollments.forEach((e) => (e.left_on = "2026-06-01"));
  loadBook.mockResolvedValue(data);
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  await expect(
    applyBookChange(
      { query } as any,
      { kind: "admin", book_id: null },
      "book",
      "students",
      {
        enrollment_id: enrollment,
        full_name: "Alumno",
        joined_on: "2026-03-01",
        left_on: null,
      },
    ),
  ).resolves.toEqual({ id: enrollment });
});

import {
  buildSchedulePreview,
  scheduleSchema,
  validateTransfers,
} from "../server/scheduleReview";
import { lessonsFor, summarize } from "../src/domain";
import { reviewSchedule } from "../src/scheduleReview";

function markedFixture() {
  const data = fixture();
  data.schedules = data.schedules.filter((s) => s.id !== "future");
  data.attendance = [
    {
      enrollment_id: enrollment,
      date: "2026-06-02",
      slot: 0,
      time: "14:00",
      status: "present",
      revision: 1,
    },
    {
      enrollment_id: enrollment,
      date: "2026-06-09",
      slot: 0,
      time: "14:00",
      status: "absent",
      revision: 2,
    },
  ];
  return data;
}
const change = {
  enrollment_id: enrollment,
  effective_from: "2026-06-03",
  slots: [{ day: 2, time: "15:00" }],
};
it("revisa un cambio a mitad de semana y conserva lo anterior y la versión siguiente", () => {
  const data = markedFixture();
  data.schedules.push({
    id: "next",
    enrollment_id: enrollment,
    effective_from: "2026-06-17",
    slots: [{ day: 3, time: "16:00" }],
  });
  const preview = reviewSchedule(data, change);
  expect(preview.affected.map((l) => l.date)).toEqual(["2026-06-09"]);
  expect(preview.to).toBe("2026-06-16");
  expect(preview.destinations.map((l) => l.date)).toEqual([
    "2026-06-03",
    "2026-06-10",
  ]);
  expect(
    lessonsFor(preview.candidate, "2026-06-02", "2026-06-02")[0].status,
  ).toBe("present");
  expect(
    lessonsFor(preview.candidate, "2026-06-18", "2026-06-18")[0].time,
  ).toBe("16:00");
});
it("detecta cambios de hora aunque fecha y posición sigan iguales", () => {
  const data = markedFixture();
  const preview = buildSchedulePreview(data, {
    ...change,
    slots: [{ day: 1, time: "15:00" }],
  });
  expect(preview.affected).toHaveLength(1);
  expect(preview.affected[0].time).toBe("14:00");
  expect(preview.destinations.find((l) => l.date === "2026-06-09")?.time).toBe(
    "15:00",
  );
});
it("permite destinos de otra semana y exige revisión y correspondencias completas", () => {
  const data = markedFixture();
  const preview = buildSchedulePreview(data, change);
  const input = scheduleSchema.parse(change);
  expect(() => validateTransfers(preview, input)).toThrow("Vuelve a revisar");
  input.review_token = preview.review_token;
  expect(() => validateTransfers(preview, input)).toThrow("Relaciona todas");
  input.transfers = [
    {
      from_date: "2026-06-09",
      from_slot: 0,
      to_date: "2026-06-24",
      to_slot: 0,
    },
  ];
  expect(() => validateTransfers(preview, input)).not.toThrow();
  const candidate = reviewSchedule(data, change).candidate;
  candidate.attendance = data.attendance.map((a) =>
    a.date === "2026-06-09" ? { ...a, date: "2026-06-24", time: "15:00" } : a,
  );
  expect(summarize(lessonsFor(candidate)).present).toBe(1);
  expect(summarize(lessonsFor(candidate)).absent).toBe(1);
});
it("rechaza destinos repetidos, inexistentes, suspendidos u ocupados", () => {
  const data = markedFixture();
  data.attendance.push({ ...data.attendance[1], date: "2026-06-16" });
  data.suspensions.push({
    id: "s",
    scope: "book",
    target_id: "book",
    start_date: "2026-06-24",
    end_date: "2026-06-24",
    reason: "Cierre",
  });
  const preview = buildSchedulePreview(data, change);
  const input = scheduleSchema.parse({
    ...change,
    review_token: preview.review_token,
    transfers: [
      {
        from_date: "2026-06-09",
        from_slot: 0,
        to_date: "2026-06-10",
        to_slot: 0,
      },
      {
        from_date: "2026-06-16",
        from_slot: 0,
        to_date: "2026-06-10",
        to_slot: 0,
      },
    ],
  });
  expect(() => validateTransfers(preview, input)).toThrow("destino disponible");
  expect(preview.destinations.some((l) => l.date === "2026-06-24")).toBe(false);
  input.transfers[1].to_date = "2026-06-11";
  expect(() => validateTransfers(preview, input)).toThrow("destino disponible");
  data.attendance.push({
    enrollment_id: enrollment,
    date: "2026-06-10",
    slot: 0,
    time: "15:00",
    status: "justified",
  });
  expect(
    buildSchedulePreview(data, change).destinations.some(
      (l) => l.date === "2026-06-10",
    ),
  ).toBe(false);
});
it("detecta cambios concurrentes y el token tolera el orden de claves de jsonb", () => {
  const data = markedFixture();
  const preview = buildSchedulePreview(data, change);
  const reordered = JSON.parse(JSON.stringify(data), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  expect(buildSchedulePreview(reordered, change).review_token).toBe(
    preview.review_token,
  );
  data.attendance[1].revision = 3;
  const updated = buildSchedulePreview(data, change);
  expect(() =>
    validateTransfers(
      updated,
      scheduleSchema.parse({ ...change, review_token: preview.review_token }),
    ),
  ).toThrow("Vuelve a revisar");
});
it("reordenar sesiones detecta ambas marcas y sugiere la misma clase física", () => {
  const data = markedFixture();
  data.book.sessions_per_week = 2;
  data.schedules[1].slots.push({ day: 3, time: "16:00" });
  data.attendance.push({
    ...data.attendance[1],
    date: "2026-06-11",
    slot: 1,
    time: "16:00",
  });
  const input = { ...change, slots: [...data.schedules[1].slots].reverse() };
  const preview = buildSchedulePreview(data, input);
  expect(preview.affected).toHaveLength(2);
  expect(preview.suggestions).toEqual([
    {
      from_date: "2026-06-09",
      from_slot: 0,
      to_date: "2026-06-09",
      to_slot: 1,
    },
    {
      from_date: "2026-06-11",
      from_slot: 1,
      to_date: "2026-06-11",
      to_slot: 0,
    },
  ]);
  expect(() =>
    validateTransfers(
      preview,
      scheduleSchema.parse({
        ...input,
        review_token: preview.review_token,
        transfers: preview.suggestions,
      }),
    ),
  ).not.toThrow();
});
it("retirar fuentes antes de insertar destinos evita sobrescribir marcas en intercambios", async () => {
  const data = markedFixture();
  data.book.sessions_per_week = 2;
  data.schedules[1].slots.push({ day: 1, time: "16:00" });
  data.attendance.push({
    ...data.attendance[1],
    slot: 1,
    time: "16:00",
    status: "justified",
  });
  const input = { ...change, slots: [...data.schedules[1].slots].reverse() };
  const preview = buildSchedulePreview(data, input);
  loadBook.mockResolvedValue(data);
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [{ id: "dest" }], rowCount: 1 });
  await applyBookChange(
    { query } as any,
    { kind: "admin", book_id: null },
    "book",
    "schedule",
    {
      ...input,
      review_token: preview.review_token,
      transfers: preview.suggestions,
    },
  );
  const calls = query.mock.calls.map(([sql]) => sql as string);
  const deletes = calls.flatMap((sql, i) =>
    sql.startsWith("DELETE FROM attendance") ? [i] : [],
  );
  const inserts = calls.flatMap((sql, i) =>
    sql.startsWith("INSERT INTO attendance") ? [i] : [],
  );
  expect(deletes).toHaveLength(2);
  expect(inserts).toHaveLength(2);
  expect(Math.max(...deletes)).toBeLessThan(Math.min(...inserts));
  expect(
    query.mock.calls
      .filter(([sql]) => sql.startsWith("INSERT INTO attendance"))
      .map(([, values]) => values[1]),
  ).toEqual(["absent", "justified"]);
});

it.each(["2026-03-01", "2026-05-13", "2026-10-30", "2026-11-30"])(
  "acepta vigencia %s sin exigir inicio de semana, mes o semestre",
  (effective_from) => {
    const data = markedFixture();
    data.attendance = [];
    expect(buildSchedulePreview(data, { ...change, effective_from }).from).toBe(
      effective_from,
    );
  },
);
it.each(["2026-02-28", "2026-12-01"])(
  "rechaza vigencia %s fuera de la matrícula y el período",
  (effective_from) => {
    expect(() =>
      buildSchedulePreview(markedFixture(), { ...change, effective_from }),
    ).toThrow("Revisa la fecha");
  },
);
it("respeta el último día de matrícula y no ofrece destinos posteriores", () => {
  const data = markedFixture();
  data.enrollments.find((e) => e.id === enrollment)!.left_on = "2026-06-18";
  const preview = buildSchedulePreview(data, change);
  expect(preview.to).toBe("2026-06-18");
  expect(preview.destinations.every((l) => l.date <= "2026-06-18")).toBe(true);
  expect(() =>
    buildSchedulePreview(data, { ...change, effective_from: "2026-06-19" }),
  ).toThrow("Revisa la fecha");
});
