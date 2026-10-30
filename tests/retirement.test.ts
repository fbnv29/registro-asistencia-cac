import { it, expect } from "vitest";
import {
  isRetired,
  lessonsFor,
  vacantSlots,
  type BookData,
} from "../src/domain";
import { visibleBook } from "../server/service";
function fixture(): BookData {
  return {
    book: {
      id: "book",
      teacher_id: "teacher",
      period_id: "period",
      discipline: "Curso",
      sessions_per_week: 1,
      duration_minutes: 45,
    },
    period: {
      id: "period",
      name: "2026",
      start_date: "2026-03-01",
      end_date: "2026-11-30",
    },
    enrollments: [
      {
        id: "withdrawn",
        student_id: "old",
        book_id: "book",
        full_name: "Retirado",
        joined_on: "2026-03-01",
        left_on: "2026-07-01",
      },
      {
        id: "active",
        student_id: "new",
        book_id: "book",
        full_name: "Activo",
        joined_on: "2026-03-01",
        left_on: null,
      },
    ],
    schedules: [
      {
        id: "old-slot",
        enrollment_id: "withdrawn",
        effective_from: "2026-03-01",
        slots: [{ day: 0, time: "15:00" }],
      },
      {
        id: "active-slot",
        enrollment_id: "active",
        effective_from: "2026-03-01",
        slots: [{ day: 4, time: "16:00" }],
      },
    ],
    attendance: [
      {
        enrollment_id: "withdrawn",
        date: "2026-03-02",
        slot: 0,
        status: "present",
      },
    ],
    suspensions: [],
  };
}
it("oculta todos los registros del retirado a profesores y conserva su historial administrativo", () => {
  const data = fixture();
  const teacher = visibleBook(data, { kind: "book", book_id: "book" });
  expect(teacher.enrollments.map((e) => e.full_name)).toEqual(["Activo"]);
  expect(teacher.schedules.map((s) => s.enrollment_id)).toEqual(["active"]);
  expect(teacher.attendance).toEqual([]);
  const admin = visibleBook(data, { kind: "admin", book_id: null });
  expect(admin.enrollments).toHaveLength(2);
  expect(
    lessonsFor(admin).some(
      (l) => l.enrollment_id === "withdrawn" && l.status === "present",
    ),
  ).toBe(true);
});
it("libera el horario retirado y deja de mostrarlo disponible al ocuparlo un reemplazo", () => {
  const data = fixture();
  expect(vacantSlots(data, "2026-08-01")).toEqual([{ day: 0, time: "15:00" }]);
  data.schedules[1].slots = [{ day: 0, time: "15:00" }];
  expect(vacantSlots(data, "2026-08-01")).toEqual([]);
  expect(data.attendance[0].enrollment_id).toBe("withdrawn");
});
it("conserva el último día matriculado y libera el horario al día siguiente", () => {
  const e = fixture().enrollments[0];
  expect(isRetired(e, "2026-06-30")).toBe(false);
  expect(isRetired(e, "2026-07-01")).toBe(false);
  expect(isRetired(e, "2026-07-02")).toBe(true);
  expect(vacantSlots(fixture(), "2026-07-01")).toEqual([]);
  expect(vacantSlots(fixture(), "2026-06-30")).toEqual([]);
});

it("no ofrece como vacante un horario parcialmente ocupado por otro alumno", () => {
  const data = fixture();
  data.schedules[1].slots = [{ day: 0, time: "15:15" }];
  expect(vacantSlots(data, "2026-08-01")).toEqual([]);
  data.schedules[1].slots[0].time = "15:45";
  expect(vacantSlots(data, "2026-08-01")).toEqual([{ day: 0, time: "15:00" }]);
});
