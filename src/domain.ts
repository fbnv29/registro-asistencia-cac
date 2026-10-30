export type Mark = "present" | "absent" | "justified";
export type Status = Mark | "pending" | "suspended";
export interface Teacher {
  archived_at?: string | null;
  id: string;
  name: string;
}
export interface Period {
  archived_at?: string | null;
  id: string;
  name: string;
  start_date: string;
  end_date: string;
}
export interface Book {
  archived_at?: string | null;
  period_archived_at?: string | null;
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
  note?: string;
  note_revision?: number;
}
export interface Suspension {
  id: string;
  scope: "center" | "teacher" | "book";
  target_id: string | null;
  start_date: string;
  end_date: string;
  reason: string;
  source?: "manual" | "holiday";
  active?: boolean;
}
export interface SavedAttendance {
  enrollment_id: string;
  date: string;
  slot: number;
  status: Mark | null;
  revision?: number;
}
export interface Lesson {
  revision?: number;
  enrollment_id: string;
  date: string;
  slot: number;
  time: string;
  status: Status;
  reason?: string;
  underlying?: Mark;
}
export interface BookData {
  can_write?: boolean;
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
  const revisions = new Map(
    data.attendance.map((a) => [
      `${a.enrollment_id}/${a.date}/${a.slot}`,
      a.revision || 0,
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
          revision: revisions.get(`${e.id}/${date}/${index}`) || 0,
          enrollment_id: e.id,
          date,
          slot: index,
          time: s.time,
          status: affected.length ? "suspended" : mark || "pending",
          underlying: mark || undefined,
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

export function isRetired(enrollment: Enrollment, on = localToday()): boolean {
  return !!enrollment.left_on && enrollment.left_on <= on;
}
/** Timetabled positions freed by withdrawals and not occupied by another enrollment. */
export function vacantSlots(data: BookData, on = localToday()): Slot[] {
  const scheduled = (e: Enrollment) =>
    data.schedules
      .filter((v) => v.enrollment_id === e.id && v.effective_from <= on)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
      ?.slots || [];
  const occupied = new Set(
    data.enrollments
      .filter((e) => e.joined_on <= on && !isRetired(e, on))
      .flatMap(scheduled)
      .map((s) => `${s.day}/${s.time}`),
  );
  const free = data.enrollments
    .filter((e) => isRetired(e, on))
    .flatMap(scheduled)
    .filter((s) => !occupied.has(`${s.day}/${s.time}`));
  return [...new Map(free.map((s) => [`${s.day}/${s.time}`, s])).values()];
}

/** Find a real dated overlap involving the changed enrollment; pre-existing overlaps do not block unrelated edits. */
export function scheduleConflict(
  data: BookData,
  targetId: string,
  from = data.period.start_date,
) {
  const byDate = new Map<string, Lesson[]>();
  for (const lesson of lessonsFor(data, from)) {
    byDate.set(lesson.date, [...(byDate.get(lesson.date) || []), lesson]);
  }
  const minutes = (time: string) =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  for (const [date, lessons] of byDate) {
    for (const lesson of lessons.filter((l) => l.enrollment_id === targetId)) {
      const start = minutes(lesson.time),
        end = start + data.book.duration_minutes;
      if (end > 1440)
        return {
          date,
          time: lesson.time,
          name: "fin del día",
          message: "La clase no puede terminar después de medianoche.",
        };
      const collision = lessons.find(
        (other) =>
          !(
            other.enrollment_id === lesson.enrollment_id &&
            other.slot === lesson.slot
          ) &&
          start < minutes(other.time) + data.book.duration_minutes &&
          minutes(other.time) < end,
      );
      if (collision) {
        const student = data.enrollments.find(
          (e) => e.id === collision.enrollment_id,
        );
        return {
          date,
          time: collision.time,
          name: student?.full_name || "otra sesión",
          message: `Ya existe un evento en ese horario: ${shortDate(date)}, ${collision.time}, ${student?.full_name || "otra sesión"}. Revisa la duración y elige un horario disponible.`,
        };
      }
    }
  }
  return null;
}
