import { describe, expect, it } from "vitest";
import {
  addDays,
  lessonsFor,
  monday,
  summarize,
  weeks,
  type BookData,
} from "../src/domain";
function fixture(count = 1): BookData {
  return {
    book: {
      id: "b",
      teacher_id: "t",
      period_id: "p",
      discipline: "Teclado",
      sessions_per_week: count,
      duration_minutes: 45,
    },
    period: {
      id: "p",
      name: "2026",
      start_date: "2026-03-01",
      end_date: "2026-11-30",
    },
    enrollments: [
      {
        id: "a",
        student_id: "s1",
        book_id: "b",
        full_name: "Lunes",
        joined_on: "2026-03-01",
        left_on: null,
      },
      {
        id: "z",
        student_id: "s2",
        book_id: "b",
        full_name: "Viernes",
        joined_on: "2026-03-01",
        left_on: null,
      },
    ],
    schedules: [
      {
        id: "v1",
        enrollment_id: "a",
        effective_from: "2026-03-01",
        slots:
          count === 1
            ? [{ day: 0, time: "15:00" }]
            : [
                { day: 0, time: "15:00" },
                { day: 2, time: "15:00" },
              ],
      },
      {
        id: "v2",
        enrollment_id: "z",
        effective_from: "2026-03-01",
        slots:
          count === 1
            ? [{ day: 4, time: "16:00" }]
            : [
                { day: 1, time: "16:00" },
                { day: 4, time: "16:00" },
              ],
      },
    ],
    attendance: [],
    suspensions: [],
  };
}
describe("Calendario lectivo y porcentajes", () => {
  it("agrupa lunes y viernes en la misma semana con sus fechas reales", () => {
    const data = fixture(),
      lessons = lessonsFor(data, "2026-03-02", "2026-03-08");
    expect(lessons.map((l) => l.date)).toEqual(["2026-03-02", "2026-03-06"]);
    expect(new Set(lessons.map((l) => monday(l.date))).size).toBe(1);
  });
  it("genera dos sesiones individuales y sin duplicados por semana", () => {
    const lessons = lessonsFor(fixture(2), "2026-03-02", "2026-03-08");
    expect(lessons).toHaveLength(4);
    expect(
      new Set(lessons.map((l) => `${l.enrollment_id}/${l.date}/${l.slot}`))
        .size,
    ).toBe(4);
  });
  it("respeta ingreso tardío, retiro y estudiantes independientes", () => {
    const data = fixture();
    data.enrollments[0].joined_on = "2026-07-01";
    data.enrollments[1].left_on = "2026-06-30";
    const result = lessonsFor(data);
    expect(
      result
        .filter((l) => l.enrollment_id === "a")
        .every((l) => l.date >= "2026-07-01"),
    ).toBe(true);
    expect(
      result
        .filter((l) => l.enrollment_id === "z")
        .every((l) => l.date <= "2026-06-30"),
    ).toBe(true);
  });
  it("un cambio de horario conserva fechas anteriores y aplica desde la fecha", () => {
    const data = fixture();
    data.schedules.push({
      id: "new",
      enrollment_id: "a",
      effective_from: "2026-03-10",
      slots: [{ day: 3, time: "17:00" }],
    });
    const result = lessonsFor(data, "2026-03-02", "2026-03-22").filter(
      (l) => l.enrollment_id === "a",
    );
    expect(result.map((l) => [l.date, l.time])).toEqual([
      ["2026-03-02", "15:00"],
      ["2026-03-09", "15:00"],
      ["2026-03-12", "17:00"],
      ["2026-03-19", "17:00"],
    ]);
  });
  it("suspende solo el día afectado y preserva una marca anterior", () => {
    const data = fixture();
    data.attendance.push({
      enrollment_id: "a",
      date: "2026-03-02",
      slot: 0,
      status: "present",
    });
    data.suspensions.push({
      id: "s",
      scope: "teacher",
      target_id: "t",
      start_date: "2026-03-02",
      end_date: "2026-03-02",
      reason: "Permiso",
    });
    let result = lessonsFor(data, "2026-03-02", "2026-03-08");
    expect(result.map((l) => l.status)).toEqual(["suspended", "pending"]);
    expect(result[0].underlying).toBe("present");
    data.suspensions = [];
    result = lessonsFor(data, "2026-03-02", "2026-03-08");
    expect(result[0].status).toBe("present");
  });
  it("aplica vacaciones de CAC, ignora otros profesores y cuenta solapamientos una sola vez", () => {
    const data = fixture();
    data.suspensions = [
      {
        id: "1",
        scope: "center",
        target_id: null,
        start_date: "2026-03-02",
        end_date: "2026-03-08",
        reason: "Vacaciones",
      },
      {
        id: "2",
        scope: "book",
        target_id: "b",
        start_date: "2026-03-02",
        end_date: "2026-03-02",
        reason: "Permiso",
      },
      {
        id: "3",
        scope: "teacher",
        target_id: "otro",
        start_date: "2026-03-09",
        end_date: "2026-03-15",
        reason: "Otro",
      },
    ];
    const result = lessonsFor(data, "2026-03-02", "2026-03-15");
    expect(summarize(result).suspended).toBe(2);
    expect(summarize(result).pending).toBe(2);
    expect(result[0].reason).toBe("Vacaciones · Permiso");
  });
  it("calcula presentes y justificadas, excluyendo pendientes y suspendidas", () => {
    const result = lessonsFor(fixture(), "2026-03-02", "2026-03-22");
    const states = [
      "present",
      "justified",
      "absent",
      "pending",
      "suspended",
      "present",
    ] as const;
    result.forEach((l, i) => (l.status = states[i]));
    expect(summarize(result)).toMatchObject({
      present: 2,
      justified: 1,
      absent: 1,
      pending: 1,
      suspended: 1,
      count: 4,
      percentage: 75,
    });
  });
  it("muestra sin registros si no hay sesiones computables", () => {
    expect(summarize([]).percentage).toBe(null);
    expect(summarize(lessonsFor(fixture())).percentage).toBe(null);
  });
  it("mantiene fechas locales al cruzar cambios de hora y año", () => {
    expect(addDays("2026-09-06", 1)).toBe("2026-09-07");
    expect(monday("2027-01-01")).toBe("2026-12-28");
    expect(weeks(fixture().period)[0]).toBe("2026-02-23");
  });
  it("soporta un período con 30 estudiantes sin mezclar registros", () => {
    const data = fixture(2);
    data.enrollments = Array.from({ length: 30 }, (_, i) => ({
      ...data.enrollments[0],
      id: `e${i}`,
      student_id: `s${i}`,
    }));
    data.schedules = data.enrollments.map((e) => ({
      id: `v${e.id}`,
      enrollment_id: e.id,
      effective_from: "2026-03-01",
      slots: [
        { day: 0, time: "15:00" },
        { day: 3, time: "16:00" },
      ],
    }));
    const result = lessonsFor(data);
    expect(result.length).toBeGreaterThan(2000);
    expect(
      new Set(result.map((l) => `${l.enrollment_id}/${l.date}/${l.slot}`)).size,
    ).toBe(result.length);
  });
});
