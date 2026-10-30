import {
  addDays,
  lessonsFor,
  type BookData,
  type Lesson,
  type Slot,
} from "./domain";

export interface ScheduleInput {
  enrollment_id: string;
  effective_from: string;
  slots: Slot[];
}
export interface AttendanceTransfer {
  from_date: string;
  from_slot: number;
  to_date: string;
  to_slot: number;
}
export interface SchedulePreview {
  previous: Slot[];
  proposed: Slot[];
  from: string;
  to: string;
  affected: Lesson[];
  destinations: Lesson[];
  suggestions: AttendanceTransfer[];
  review_token: string;
}
export const lessonKey = (l: { date: string; slot: number }) =>
  `${l.date}/${l.slot}`;

// Pure projection shared by validation and tests. Only marked sessions need relocation.
export function reviewSchedule(data: BookData, input: ScheduleInput) {
  const versions = data.schedules
    .filter((s) => s.enrollment_id === input.enrollment_id)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const next = versions.find((s) => s.effective_from > input.effective_from);
  const enrollment = data.enrollments.find(
    (e) => e.id === input.enrollment_id,
  )!;
  const to = [
    next ? addDays(next.effective_from, -1) : data.period.end_date,
    enrollment.left_on || data.period.end_date,
    data.period.end_date,
  ].sort()[0];
  const candidate = {
    ...data,
    schedules: [
      ...data.schedules.filter(
        (s) =>
          !(
            s.enrollment_id === input.enrollment_id &&
            s.effective_from === input.effective_from
          ),
      ),
      { id: "proposed", ...input },
    ],
  };
  const old = lessonsFor(data, input.effective_from, to).filter(
    (l) => l.enrollment_id === input.enrollment_id,
  );
  const proposed = lessonsFor(candidate, input.effective_from, to).filter(
    (l) => l.enrollment_id === input.enrollment_id,
  );
  const marked = data.attendance
    .filter(
      (a) =>
        a.enrollment_id === input.enrollment_id &&
        a.status &&
        a.date >= input.effective_from &&
        a.date <= to,
    )
    .sort((a, b) => lessonKey(a).localeCompare(lessonKey(b)));
  const affected = marked.flatMap((a) => {
    const source = old.find((l) => lessonKey(l) === lessonKey(a));
    const dest = proposed.find((l) => lessonKey(l) === lessonKey(a));
    // Persisted time is authoritative, including for older inconsistent schedules.
    const time = a.time || source?.time;
    if (dest && time === dest.time) return [];
    return [
      {
        ...source,
        ...a,
        time: time || "",
        status: a.status!,
        underlying: a.status!,
        revision: a.revision || 0,
      } as Lesson,
    ];
  });
  const affectedKeys = new Set(affected.map(lessonKey));
  const occupied = new Set(
    marked.filter((a) => !affectedKeys.has(lessonKey(a))).map(lessonKey),
  );
  const destinations = proposed.filter(
    (l) => l.status !== "suspended" && !occupied.has(lessonKey(l)),
  );
  const suggestions: AttendanceTransfer[] = [];
  // Suggest only a unique physical session match, or a single source/destination pair.
  for (const source of affected) {
    const matches = destinations.filter(
      (l) => l.date === source.date && l.time === source.time,
    );
    const dest =
      matches.length === 1
        ? matches[0]
        : affected.length === 1 && destinations.length === 1
          ? destinations[0]
          : undefined;
    if (
      dest &&
      !suggestions.some(
        (s) => s.to_date === dest.date && s.to_slot === dest.slot,
      )
    )
      suggestions.push({
        from_date: source.date,
        from_slot: source.slot,
        to_date: dest.date,
        to_slot: dest.slot,
      });
  }
  return {
    candidate,
    previous:
      versions.filter((s) => s.effective_from <= input.effective_from).at(-1)
        ?.slots || [],
    proposed: input.slots,
    from: input.effective_from,
    to,
    affected,
    destinations,
    suggestions,
  };
}
