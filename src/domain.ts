export type Mark = "present" | "absent" | "justified";
export type Status = Mark | "pending" | "suspended";
export interface Teacher {
  id: string;
  name: string;
}
export interface Period {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
}
export interface Book {
  id: string;
  teacher_id: string;
  period_id: string;
  discipline: string;
  sessions_per_week: number;
  duration_minutes: number;
  teacher_name?: string;
  period_name?: string;
  start_date?: string;
  end_date?: string;
}
export interface Slot {
  day: number;
  time: string;
}
export interface Schedule {
  id: string;
  enrollment_id: string;
  effective_from: string;
  slots: Slot[];
}
export interface Enrollment {
  id: string;
  student_id: string;
  book_id: string;
  full_name: string;
  joined_on: string;
  left_on: string | null;
}
export interface Suspension {
  id: string;
  scope: "center" | "teacher" | "book";
  target_id: string | null;
  start_date: string;
  end_date: string;
  reason: string;
}
export interface SavedAttendance {
  enrollment_id: string;
  date: string;
  slot: number;
  status: Mark;
}
export interface Lesson {
  enrollment_id: string;
  date: string;
  slot: number;
  time: string;
  status: Status;
  reason?: string;
  underlying?: Mark;
}
export interface BookData {
  book: Book;
  period: Period;
  enrollments: Enrollment[];
  schedules: Schedule[];
  suspensions: Suspension[];
  attendance: SavedAttendance[];
}
export const labels: Record<Status, string> = {
  present: "Presente",
  absent: "Ausente",
  justified: "Falta justificada",
  pending: "Pendiente",
  suspended: "Suspendida",
};
export const days = [
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
  "Domingo",
];
export function addDays(date: string, amount: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
export function dayIndex(date: string): number {
  return (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7;
}
export function monday(date: string) {
  return addDays(date, -dayIndex(date));
}
export function localToday() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Santiago",
  }).format(new Date());
}
export function shortDate(date: string) {
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(date + "T12:00:00Z"));
}
export function weeks(period: Period): string[] {
  const out: string[] = [];
  for (
    let d = monday(period.start_date);
    d <= period.end_date;
    d = addDays(d, 7)
  )
    out.push(d);
  return out;
}
export function lessonsFor(
  data: BookData,
  from = data.period.start_date,
  to = data.period.end_date,
): Lesson[] {
  const result: Lesson[] = [];
  const marks = new Map(
    data.attendance.map((a) => [
      `${a.enrollment_id}/${a.date}/${a.slot}`,
      a.status,
    ]),
  );
  const suspensions = data.suspensions.filter(
    (s) =>
      s.scope === "center" ||
      (s.scope === "teacher" && s.target_id === data.book.teacher_id) ||
      (s.scope === "book" && s.target_id === data.book.id),
  );
  for (const e of data.enrollments) {
    const versions = data.schedules
      .filter((s) => s.enrollment_id === e.id)
      .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    const start = [from, data.period.start_date, e.joined_on].sort().at(-1)!;
    const end = [
      to,
      data.period.end_date,
      e.left_on || data.period.end_date,
    ].sort()[0];
    let version = 0;
    for (let date = start; date <= end; date = addDays(date, 1)) {
      while (
        version + 1 < versions.length &&
        versions[version + 1].effective_from <= date
      )
        version++;
      const schedule = versions[version];
      if (!schedule || schedule.effective_from > date) continue;
      schedule.slots.forEach((s, index) => {
        if (s.day !== dayIndex(date)) return;
        const mark = marks.get(`${e.id}/${date}/${index}`);
        const affected = suspensions.filter(
          (s) => s.start_date <= date && s.end_date >= date,
        );
        result.push({
          enrollment_id: e.id,
          date,
          slot: index,
          time: s.time,
          status: affected.length ? "suspended" : mark || "pending",
          underlying: mark,
          reason: affected.length
            ? [...new Set(affected.map((s) => s.reason))].join(" · ")
            : undefined,
        });
      });
    }
  }
  return result.sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
  );
}
export function summarize(lessons: Lesson[]) {
  const totals: Record<Status, number> = {
    present: 0,
    absent: 0,
    justified: 0,
    pending: 0,
    suspended: 0,
  };
  lessons.forEach((l) => totals[l.status]++);
  const count = totals.present + totals.absent + totals.justified;
  return {
    ...totals,
    count,
    percentage: count
      ? Math.round(((totals.present + totals.justified) / count) * 1000) / 10
      : null,
  };
}
