import { it, expect } from "vitest";
import { chileHolidays, holidaysBetween } from "../server/holidays";
import { scheduleConflict, type BookData } from "../src/domain";
function fixture(): BookData {
  return {
    book: {
      id: "b",
      teacher_id: "t",
      period_id: "p",
      discipline: "Curso",
      sessions_per_week: 1,
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
        student_id: "a",
        book_id: "b",
        full_name: "Alumno A",
        joined_on: "2026-03-01",
        left_on: null,
      },
      {
        id: "b",
        student_id: "b",
        book_id: "b",
        full_name: "Alumno B",
        joined_on: "2026-03-01",
        left_on: null,
      },
    ],
    schedules: [
      {
        id: "sa",
        enrollment_id: "a",
        effective_from: "2026-03-01",
        slots: [{ day: 0, time: "14:00" }],
      },
      {
        id: "sb",
        enrollment_id: "b",
        effective_from: "2026-03-01",
        slots: [{ day: 0, time: "14:00" }],
      },
    ],
    attendance: [],
    suspensions: [],
  };
}
it("genera los feriados nacionales de 2026, incluyendo Sábado Santo y excluyendo feriados bancarios y regionales", () => {
  const dates = chileHolidays(2026).map((h) => h.start_date);
  expect(dates).toEqual([
    "2026-01-01",
    "2026-04-03",
    "2026-04-04",
    "2026-05-01",
    "2026-05-21",
    "2026-06-21",
    "2026-06-29",
    "2026-07-16",
    "2026-08-15",
    "2026-09-18",
    "2026-09-19",
    "2026-10-12",
    "2026-10-31",
    "2026-11-01",
    "2026-12-08",
    "2026-12-25",
  ]);
  expect(new Set(dates).size).toBe(dates.length);
});
it("calcula Semana Santa para otro año y respeta las excepciones del centro", () => {
  expect(
    holidaysBetween("2027-03-01", "2027-03-31").map((h) => h.start_date),
  ).toEqual(["2027-03-26", "2027-03-27"]);
  expect(
    holidaysBetween("2026-05-01", "2026-05-01", new Set(["2026-05-01"])),
  ).toEqual([]);
});
it("rechaza eventos simultáneos y cruces parciales según su duración", () => {
  const data = fixture();
  expect(scheduleConflict(data, "b")?.message).toContain("Ya existe un evento");
  data.schedules[1].slots[0].time = "14:30";
  expect(scheduleConflict(data, "b")).not.toBe(null);
  data.schedules[1].slots[0].time = "14:45";
  expect(scheduleConflict(data, "b")).toBe(null);
});
it("permite otro día y el reemplazo después del retiro, sin borrar el horario histórico", () => {
  const data = fixture();
  data.schedules[1].slots[0].day = 1;
  expect(scheduleConflict(data, "b")).toBe(null);
  data.schedules[1].slots[0].day = 0;
  data.enrollments[0].left_on = "2026-06-30";
  data.enrollments[1].joined_on = "2026-07-01";
  expect(scheduleConflict(data, "b")).toBe(null);
  expect(data.schedules).toHaveLength(2);
});
it("valida solo la matrícula modificada y la vigencia del horario propuesto", () => {
  const data = fixture();
  data.schedules[1].slots[0].day = 1;
  data.schedules.push({
    id: "future",
    enrollment_id: "b",
    effective_from: "2026-07-01",
    slots: [{ day: 0, time: "14:15" }],
  });
  expect(scheduleConflict(data, "b", "2026-07-01")).not.toBe(null);
  expect(scheduleConflict(data, "b", "2026-12-01")).toBe(null);
});

it("rechaza clases que terminan después de medianoche y permite terminar a las 00:00", () => {
  const data = fixture();
  data.schedules[0].slots[0].time = "23:30";
  expect(scheduleConflict(data, "a")?.message).toContain("medianoche");
  data.schedules[0].slots[0].time = "23:15";
  expect(scheduleConflict(data, "a")).toBe(null);
});
