import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BookOpen,
  Plus,
  LockKeyhole,
  ArrowLeft,
  LogOut,
  Settings,
  CalendarDays,
  Users,
  ClipboardCheck,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  Search,
  Download,
  Clock3,
  ShieldCheck,
  Pencil,
  CircleHelp,
} from "lucide-react";
import { api } from "./api";
import {
  addDays,
  days,
  labels,
  lessonsFor,
  localToday,
  monday,
  shortDate,
  summarize,
  weeks,
  type Book,
  type BookData,
  type Enrollment,
  type Lesson,
  type Mark,
  type Period,
  type Slot,
  type Status,
  type Suspension,
  type Teacher,
} from "./domain";
type Access = { kind: "admin" | "creator" | "book"; book_id: string | null };
type Catalog = {
  books: Book[];
  teachers: Teacher[];
  periods: Period[];
  environment: string;
};
function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current;
    root?.querySelector<HTMLElement>("input,select,button")?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && root) {
        const items = Array.from(
          root.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
          ),
        );
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" aria-label="Cerrar" onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function SubmitForm({
  children,
  onSubmit,
  label = "Guardar",
  onDone,
}: {
  children: ReactNode;
  onSubmit: (form: FormData) => Promise<unknown>;
  label?: string;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        try {
          await onSubmit(form);
          onDone?.();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && <Alert>{error}</Alert>}
      <button className="button primary form-submit" disabled={busy}>
        {busy ? "Guardando…" : label}
      </button>
    </form>
  );
}
function PasswordDialog({
  kind,
  book,
  onClose,
  onLogin,
}: {
  kind: Access["kind"];
  book?: Book;
  onClose: () => void;
  onLogin: (a: Access) => void;
}) {
  return (
    <Modal
      title={
        kind === "admin"
          ? "Administración"
          : kind === "creator"
            ? "Crear un libro"
            : book!.discipline
      }
      onClose={onClose}
    >
      <div className="password-intro">
        <span className="lock-symbol">
          <LockKeyhole size={26} />
        </span>
        <p>
          {kind === "book"
            ? `Libro de ${book!.teacher_name}. Ingresa la contraseña para continuar.`
            : kind === "creator"
              ? "Ingresa la contraseña de creación de libros."
              : "Ingresa la contraseña de administración del CAC."}
        </p>
      </div>
      <SubmitForm
        label="Entrar"
        onSubmit={async (f) => {
          const a = await api<Access>("/login", {
            kind,
            book_id: book?.id,
            password: f.get("password"),
          });
          onLogin(a);
        }}
      >
        <Field label="Contraseña">
          <input
            name="password"
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
            placeholder="Escribe tu contraseña"
          />
        </Field>
      </SubmitForm>
    </Modal>
  );
}
function SlotsFields({ count, initial }: { count: number; initial?: Slot[] }) {
  return (
    <div className="slots-fields">
      {Array.from({ length: count }, (_, i) => (
        <div className="slot-fields" key={i}>
          <span className="slot-number">Sesión {i + 1}</span>
          <Field label="Día">
            <select name={`day${i}`} defaultValue={initial?.[i]?.day ?? i}>
              {days.map((d, i) => (
                <option value={i} key={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Hora">
            <input
              type="time"
              required
              name={`time${i}`}
              defaultValue={initial?.[i]?.time || "15:00"}
            />
          </Field>
        </div>
      ))}
    </div>
  );
}
const readSlots = (f: FormData, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    day: Number(f.get(`day${i}`)),
    time: String(f.get(`time${i}`)),
  }));
function CreateBook({
  catalog,
  onClose,
  onDone,
}: {
  catalog: Catalog;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  return (
    <Modal title="Un nuevo libro de clases" onClose={onClose}>
      <p className="muted">Completa los datos para crear el libro de clases.</p>
      {!catalog.teachers.length || !catalog.periods.length ? (
        <Alert>
          Administración debe agregar profesores y un período lectivo antes de
          crear libros.
        </Alert>
      ) : (
        <SubmitForm
          label="Crear libro"
          onSubmit={async (f) => {
            const result = await api("/books", {
              teacher_id: f.get("teacher_id"),
              period_id: f.get("period_id"),
              discipline: f.get("discipline"),
              sessions_per_week: Number(f.get("sessions")),
              password: f.get("password"),
            });
            onDone(result.id);
          }}
        >
          <Field label="Tu nombre">
            <select required name="teacher_id">
              {catalog.teachers.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Disciplina">
            <input
              name="discipline"
              placeholder="Por ejemplo, Teclado"
              required
              maxLength={120}
            />
          </Field>
          <div className="two-fields">
            <Field label="Período lectivo">
              <select name="period_id">
                {catalog.periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sesiones por semana">
              <input
                type="number"
                name="sessions"
                min={1}
                max={7}
                defaultValue={1}
                required
              />
            </Field>
          </div>
          <Field label="Contraseña de este libro">
            <input
              name="password"
              type="password"
              minLength={6}
              maxLength={128}
              required
              autoComplete="new-password"
            />
          </Field>
          <p className="hint">
            Al menos 6 caracteres. Administración puede restablecerla si la
            olvidas.
          </p>
        </SubmitForm>
      )}
    </Modal>
  );
}
function StudentForm({
  data,
  student,
  onClose,
  onDone,
}: {
  data: BookData;
  student?: Enrollment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [fromStart, setFromStart] = useState(!student);
  return (
    <Modal
      title={student ? "Editar estudiante" : "Agregar estudiante"}
      onClose={onClose}
    >
      <SubmitForm
        onDone={onDone}
        label={student ? "Guardar cambios" : "Agregar al libro"}
        onSubmit={(f) =>
          api(`/books/${data.book.id}/students`, {
            enrollment_id: student?.id,
            full_name: f.get("full_name"),
            joined_on:
              student?.joined_on ||
              (fromStart ? data.period.start_date : f.get("joined_on")),
            left_on: f.get("left_on") || null,
            ...(!student
              ? { slots: readSlots(f, data.book.sessions_per_week) }
              : {}),
          })
        }
      >
        <Field label="Nombre completo">
          <input
            name="full_name"
            defaultValue={student?.full_name}
            required
            maxLength={120}
            placeholder="Nombre y apellidos"
          />
        </Field>
        {!student ? (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={fromStart}
                onChange={(e) => setFromStart(e.target.checked)}
              />{" "}
              Está desde el inicio del período
            </label>
            {!fromStart && (
              <Field label="Fecha de ingreso">
                <input
                  type="date"
                  name="joined_on"
                  required
                  min={data.period.start_date}
                  max={data.period.end_date}
                  defaultValue={
                    localToday() > data.period.end_date
                      ? data.period.end_date
                      : localToday() < data.period.start_date
                        ? data.period.start_date
                        : localToday()
                  }
                />
              </Field>
            )}
            <h3>Horario semanal</h3>
            <p className="hint">
              Cada sesión tendrá su propia casilla de asistencia.
            </p>
            <SlotsFields count={data.book.sessions_per_week} />
          </>
        ) : (
          <>
            <p className="hint">
              Ingreso: {shortDate(student.joined_on)}. El historial permanece en
              el libro.
            </p>
            <Field label="Último día de asistencia (opcional)">
              <input
                type="date"
                name="left_on"
                min={student.joined_on}
                max={data.period.end_date}
                defaultValue={student.left_on || ""}
              />
            </Field>
            <p className="hint">
              Deja la fecha vacía si continúa en el taller.
            </p>
          </>
        )}
      </SubmitForm>
    </Modal>
  );
}
function ScheduleForm({
  data,
  student,
  onClose,
  onDone,
}: {
  data: BookData;
  student: Enrollment;
  onClose: () => void;
  onDone: () => void;
}) {
  const versions = data.schedules
    .filter((s) => s.enrollment_id === student.id)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return (
    <Modal title={`Horario de ${student.full_name}`} onClose={onClose}>
      <SubmitForm
        onDone={onDone}
        onSubmit={(f) =>
          api(`/books/${data.book.id}/schedule`, {
            enrollment_id: student.id,
            effective_from: f.get("effective_from"),
            slots: readSlots(f, data.book.sessions_per_week),
          })
        }
      >
        <p className="muted">
          El horario anterior se conserva hasta la fecha del cambio.
        </p>
        <Field label="Aplicar desde">
          <input
            type="date"
            required
            name="effective_from"
            min={student.joined_on}
            max={student.left_on || data.period.end_date}
            defaultValue={
              [student.joined_on, localToday()].sort().at(-1)! >
              (student.left_on || data.period.end_date)
                ? student.left_on || data.period.end_date
                : [student.joined_on, localToday()].sort().at(-1)
            }
          />
        </Field>
        <SlotsFields
          count={data.book.sessions_per_week}
          initial={
            versions.find((v) => v.effective_from <= localToday())?.slots ||
            versions.at(-1)?.slots
          }
        />
      </SubmitForm>
    </Modal>
  );
}
function AttendanceSymbol({ status }: { status: Status }) {
  if (status === "present")
    return (
      <Check
        className="attendance-symbol present"
        aria-hidden="true"
        strokeWidth={4}
      />
    );
  if (status === "absent")
    return (
      <X
        className="attendance-symbol absent"
        aria-hidden="true"
        strokeWidth={4}
      />
    );
  if (status === "justified")
    return (
      <span className="attendance-symbol justified" aria-hidden="true">
        J
      </span>
    );
  return (
    <span className={`attendance-symbol ${status}`} aria-hidden="true">
      {status === "suspended" ? "—" : "·"}
    </span>
  );
}
function AttendanceGrid({
  data,
  setData,
}: {
  data: BookData;
  setData: React.Dispatch<React.SetStateAction<BookData | null>>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const allWeeks = weeks(data.period);
  const currentWeek = monday(localToday());
  const [filter, setFilter] = useState("");
  const [focusWeek, setFocusWeek] = useState(() => {
    const today = monday(localToday());
    return allWeeks.includes(today)
      ? today
      : today < allWeeks[0]
        ? allWeeks[0]
        : allWeeks.at(-1)!;
  });
  const [saves, setSaves] = useState<
    Record<
      string,
      {
        state: "saving" | "saved" | "error";
        status: Mark | null;
        message?: string;
      }
    >
  >({});
  const all = lessonsFor(data),
    lookup = new Map<string, Lesson[]>();
  for (const l of all) {
    const key = `${l.enrollment_id}/${monday(l.date)}/${l.slot}`;
    lookup.set(key, [...(lookup.get(key) || []), l]);
  }
  useEffect(() => {
    const target = scroll.current?.querySelector<HTMLElement>(
      `[data-week="${focusWeek}"]`,
    );
    if (target && scroll.current) {
      const studentWidth =
        scroll.current.querySelector(".student-column")?.getBoundingClientRect()
          .width || 230;
      scroll.current.scrollLeft = target.offsetLeft - studentWidth;
    }
  }, [focusWeek]);
  async function save(lesson: Lesson, status: Mark | null) {
    const key = `${lesson.enrollment_id}/${lesson.date}/${lesson.slot}`;
    setSaves((v) => ({ ...v, [key]: { state: "saving", status } }));
    try {
      await api(`/books/${data.book.id}/attendance`, {
        enrollment_id: lesson.enrollment_id,
        date: lesson.date,
        slot: lesson.slot,
        status,
      });
      setData((previous) =>
        previous
          ? {
              ...previous,
              attendance: [
                ...previous.attendance.filter(
                  (a) =>
                    !(
                      a.enrollment_id === lesson.enrollment_id &&
                      a.date === lesson.date &&
                      a.slot === lesson.slot
                    ),
                ),
                ...(status
                  ? [
                      {
                        enrollment_id: lesson.enrollment_id,
                        date: lesson.date,
                        slot: lesson.slot,
                        status,
                      },
                    ]
                  : []),
              ],
            }
          : previous,
      );
      setSaves((v) => ({ ...v, [key]: { state: "saved", status } }));
    } catch (e) {
      setSaves((v) => ({
        ...v,
        [key]: { state: "error", status, message: (e as Error).message },
      }));
    }
  }
  const saving = Object.values(saves).some((s) => s.state === "saving"),
    errors = Object.values(saves).filter((s) => s.state === "error").length;
  const totals = summarize(all.filter((l) => l.date <= localToday()));
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Registro de asistencia</h2>
          <p>Selecciona una casilla para registrar o corregir su asistencia.</p>
        </div>
        <div className={`save-status ${errors ? "failed" : ""}`} role="status">
          {saving ? (
            <>
              <Clock3 size={16} /> Guardando…
            </>
          ) : errors ? (
            <>
              <X size={16} /> {errors} cambio(s) sin guardar
            </>
          ) : (
            <>
              <Check size={16} />{" "}
              {Object.keys(saves).length ? "Cambios guardados" : "Libro al día"}
            </>
          )}
        </div>
      </div>
      <div className="grid-toolbar">
        <div className="search-field">
          <Search size={18} />
          <input
            aria-label="Buscar estudiante"
            placeholder="Buscar estudiante…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="week-nav">
          <button
            className="icon-button"
            aria-label="Semana anterior"
            disabled={focusWeek === allWeeks[0]}
            onClick={() =>
              setFocusWeek(
                allWeeks[Math.max(0, allWeeks.indexOf(focusWeek) - 1)],
              )
            }
          >
            <ChevronLeft />
          </button>
          <select
            aria-label="Ir a semana"
            value={focusWeek}
            onChange={(e) => setFocusWeek(e.target.value)}
          >
            {allWeeks.map((w, i) => (
              <option key={w} value={w}>
                Semana {i + 1} · {shortDate(w)}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label="Semana siguiente"
            disabled={focusWeek === allWeeks.at(-1)}
            onClick={() =>
              setFocusWeek(
                allWeeks[
                  Math.min(allWeeks.length - 1, allWeeks.indexOf(focusWeek) + 1)
                ],
              )
            }
          >
            <ChevronRight />
          </button>
        </div>
      </div>
      <div className="legend">
        {(
          ["present", "absent", "justified", "suspended", "pending"] as const
        ).map((s) => (
          <span key={s}>
            <AttendanceSymbol status={s} />
            {labels[s]}
          </span>
        ))}
      </div>
      <div
        className="attendance-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="Cuadrícula de asistencia. Desplázate horizontalmente para ver más semanas."
      >
        <table
          className="attendance-table"
          data-sessions={data.book.sessions_per_week}
        >
          <thead>
            <tr>
              <th className="student-column">
                <strong>ASISTENCIA</strong>
                <span>{data.enrollments.length} estudiantes</span>
              </th>
              {allWeeks.map((w, i) => (
                <th
                  key={w}
                  data-week={w}
                  aria-current={currentWeek === w ? "date" : undefined}
                  className={currentWeek === w ? "active-week" : ""}
                >
                  <span>SEMANA {i + 1}</span>
                  <strong>
                    {shortDate(w)} — {shortDate(addDays(w, 6))}
                  </strong>
                  <div className="session-heads">
                    {Array.from(
                      { length: data.book.sessions_per_week },
                      (_, i) => (
                        <small key={i}>Sesión {i + 1}</small>
                      ),
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.enrollments
              .filter((e) =>
                e.full_name
                  .toLocaleLowerCase("es")
                  .includes(filter.toLocaleLowerCase("es")),
              )
              .map((e, i) => (
                <tr key={e.id}>
                  <th scope="row" className="student-column">
                    <span className="student-name">
                      {e.full_name}
                      {e.left_on && (
                        <small>Retiro: {shortDate(e.left_on)}</small>
                      )}
                    </span>
                    <span className="row-number">{i + 1}</span>
                  </th>
                  {allWeeks.map((w) => (
                    <td
                      key={w}
                      className={currentWeek === w ? "active-week" : ""}
                    >
                      <div className="session-cells">
                        {Array.from(
                          { length: data.book.sessions_per_week },
                          (_, s) => {
                            const cellLessons = lookup.get(`${e.id}/${w}/${s}`);
                            if (!cellLessons)
                              return (
                                <span
                                  className="no-session"
                                  key={s}
                                  title="Sin sesión en esta semana"
                                >
                                  —
                                </span>
                              );
                            return (
                              <div className="weekly-slot" key={s}>
                                {cellLessons.map((lesson) => {
                                  const key = `${e.id}/${lesson.date}/${s}`,
                                    saveState = saves[key];
                                  return (
                                    <div
                                      className="attendance-cell"
                                      key={lesson.date}
                                    >
                                      {lesson.status === "suspended" ? (
                                        <span
                                          className="suspension-cell"
                                          title={`${shortDate(lesson.date)} · ${lesson.reason}`}
                                          role="img"
                                          aria-label={`Suspendida: ${lesson.reason}, ${lesson.date}`}
                                        >
                                          <AttendanceSymbol status="suspended" />
                                        </span>
                                      ) : (
                                        <>
                                          <div
                                            className={`symbol-control ${lesson.status} ${saveState?.state === "saving" ? "is-saving" : ""}`}
                                            title={`${e.full_name} · ${lesson.date} · ${labels[lesson.status]}`}
                                          >
                                            <AttendanceSymbol
                                              status={lesson.status}
                                            />
                                            <select
                                              aria-label={`${e.full_name}, ${lesson.date}, sesión ${s + 1}`}
                                              className={`symbol-select mark ${lesson.status}`}
                                              value={
                                                lesson.status === "pending"
                                                  ? ""
                                                  : lesson.status
                                              }
                                              disabled={
                                                saveState?.state === "saving"
                                              }
                                              onChange={(event) =>
                                                void save(
                                                  lesson,
                                                  (event.target
                                                    .value as Mark) || null,
                                                )
                                              }
                                            >
                                              <option value="">
                                                Pendiente
                                              </option>
                                              <option value="present">
                                                Presente
                                              </option>
                                              <option value="absent">
                                                Ausente
                                              </option>
                                              <option value="justified">
                                                Justificada
                                              </option>
                                            </select>
                                          </div>
                                          {saveState?.state === "error" && (
                                            <button
                                              className="retry"
                                              title={saveState.message}
                                              onClick={() =>
                                                void save(
                                                  lesson,
                                                  saveState.status,
                                                )
                                              }
                                            >
                                              Reintentar
                                            </button>
                                          )}
                                        </>
                                      )}
                                      <span className="cell-date">
                                        {shortDate(lesson.date)}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          },
                        )}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {!data.enrollments.length && (
          <div className="empty-state">
            <Users size={30} />
            <h3>Tu libro está listo para empezar</h3>
            <p>
              Agrega tu primer estudiante y su horario para pasar asistencia.
            </p>
          </div>
        )}
      </div>
      <div className="grid-footer">
        <span>
          <CircleHelp size={16} /> Puedes corregir cualquier semana. Las
          casillas se guardan al elegir un estado.
        </span>
        <span>{totals.pending} sesiones pendientes hasta hoy</span>
      </div>
    </>
  );
}
function Reports({ data }: { data: BookData }) {
  const [from, setFrom] = useState(data.period.start_date),
    [to, setTo] = useState(
      localToday() < data.period.end_date
        ? localToday() < data.period.start_date
          ? data.period.start_date
          : localToday()
        : data.period.end_date,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const all = lessonsFor(data, from, to),
    total = summarize(all);
  async function download() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
        `/api/books/${data.book.id}/export?from=${from}&to=${to}`,
      );
      if (!r.ok) throw new Error((await r.json()).error);
      const href = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = "asistencia-cac.xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 5000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Resumen de asistencia</h2>
          <p>
            Presentes y justificados cuentan como asistencia. Las suspensiones
            quedan fuera.
          </p>
        </div>
        <button
          className="button primary"
          onClick={() => void download()}
          disabled={busy || from > to}
        >
          <Download size={18} />
          {busy ? "Preparando…" : "Exportar Excel"}
        </button>
      </div>
      <div className="report-dates">
        <Field label="Desde">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            min={data.period.start_date}
            max={to}
          />
        </Field>
        <Field label="Hasta">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            min={from}
            max={data.period.end_date}
          />
        </Field>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="stats">
        {[
          [
            "Asistencia",
            total.percentage === null
              ? "Sin registros"
              : `${total.percentage}%`,
          ],
          ["Presentes", total.present],
          ["Justificadas", total.justified],
          ["Ausentes", total.absent],
          ["Pendientes", total.pending],
          ["Suspendidas", total.suspended],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="table-scroll">
        <table className="plain-table">
          <thead>
            <tr>
              <th>Estudiante</th>
              <th>Presente</th>
              <th>Justificada</th>
              <th>Ausente</th>
              <th>Pendiente</th>
              <th>Suspendida</th>
              <th>Asistencia</th>
            </tr>
          </thead>
          <tbody>
            {data.enrollments.map((e) => {
              const s = summarize(all.filter((l) => l.enrollment_id === e.id));
              return (
                <tr key={e.id}>
                  <th>{e.full_name}</th>
                  <td>{s.present}</td>
                  <td>{s.justified}</td>
                  <td>{s.absent}</td>
                  <td>{s.pending}</td>
                  <td>{s.suspended}</td>
                  <td>
                    <strong>
                      {s.percentage === null
                        ? "Sin registros"
                        : `${s.percentage}%`}
                    </strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Los pendientes se muestran aparte y no participan en el porcentaje. Cada
        estudiante se calcula según su matrícula y sus sesiones.
      </p>
    </>
  );
}
function BookView({
  bookId,
  onBack,
  access,
  onAdmin,
}: {
  bookId: string;
  onBack: () => void;
  access: Access | null;
  onAdmin: () => void;
}) {
  const [data, setData] = useState<BookData | null>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState("attendance"),
    [studentModal, setStudentModal] = useState<Enrollment | "new" | null>(null),
    [scheduleModal, setScheduleModal] = useState<Enrollment | null>(null),
    [scheduleDate, setScheduleDate] = useState(localToday());
  const refresh = () =>
    api<BookData>(`/books/${bookId}`)
      .then((d) => {
        setData(d);
        setScheduleDate(
          localToday() < d.period.start_date
            ? d.period.start_date
            : localToday() > d.period.end_date
              ? d.period.end_date
              : localToday(),
        );
        setError("");
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, [bookId]);
  async function done() {
    await refresh();
    setStudentModal(null);
    setScheduleModal(null);
  }
  if (!data)
    return (
      <main className="container">
        <button className="button" onClick={onBack}>
          <ArrowLeft /> Volver
        </button>
        {error ? (
          <>
            <Alert>{error}</Alert>
            <button className="button" onClick={() => void refresh()}>
              Reintentar
            </button>
          </>
        ) : (
          <p>Cargando tu libro…</p>
        )}
      </main>
    );
  const tabs = [
    ["attendance", "Asistencia", ClipboardCheck],
    ["schedule", "Horario", CalendarDays],
    ["students", "Estudiantes", Users],
    ["reports", "Resumen", ChartNoAxesCombined],
  ] as const;
  return (
    <main className="container book-page">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={17} /> Todos los libros
      </button>
      <div className="book-title">
        <div className="book-title-icon">
          <BookOpen size={31} />
        </div>
        <div>
          <span className="eyebrow">LIBRO DE CLASES · {data.period.name}</span>
          <h1>{data.book.discipline}</h1>
          <p>
            {data.book.teacher_name} <span>·</span>{" "}
            {data.book.sessions_per_week}{" "}
            {data.book.sessions_per_week === 1 ? "sesión" : "sesiones"} por
            semana <span>·</span> {data.book.duration_minutes} min por sesión
          </p>
        </div>
        <button
          className="button primary add-student"
          onClick={() => setStudentModal("new")}
        >
          <Plus size={19} /> Agregar estudiante
        </button>
      </div>
      <div className="book-tabs" role="tablist" aria-label="Hojas del libro">
        {tabs.map(([key, label, Icon]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            key={key}
            onClick={() => setTab(key)}
            className={tab === key ? "selected" : ""}
          >
            <Icon size={19} />
            {label}
          </button>
        ))}
      </div>
      <section
        className="book-sheet"
        role="tabpanel"
        aria-label={tabs.find((t) => t[0] === tab)?.[1]}
      >
        {error && <Alert>{error}</Alert>}
        {tab === "attendance" && (
          <AttendanceGrid data={data} setData={setData} />
        )}{" "}
        {tab === "reports" && <Reports data={data} />}{" "}
        {tab === "students" && (
          <>
            <div className="section-heading">
              <div>
                <h2>Estudiantes del libro</h2>
                <p>El historial de quienes se retiran permanece aquí.</p>
              </div>
            </div>
            <div className="student-list">
              {data.enrollments.map((e) => (
                <div key={e.id}>
                  <span className="avatar">{e.full_name[0]}</span>
                  <div>
                    <strong>{e.full_name}</strong>
                    <small>
                      Desde {shortDate(e.joined_on)}
                      {e.left_on ? ` · Retiro ${shortDate(e.left_on)}` : ""}
                    </small>
                  </div>
                  <button
                    className="button small"
                    onClick={() => setStudentModal(e)}
                  >
                    <Pencil size={16} /> Editar
                  </button>
                  <button
                    className="button small"
                    onClick={() => setScheduleModal(e)}
                  >
                    <Clock3 size={16} /> Horario
                  </button>
                </div>
              ))}
            </div>
            {!data.enrollments.length && (
              <p className="empty-state">
                Aún no hay estudiantes. Usa «Agregar estudiante» para comenzar.
              </p>
            )}
          </>
        )}{" "}
        {tab === "schedule" && (
          <>
            <div className="section-heading">
              <div>
                <h2>Horario semanal</h2>
                <p>
                  La distribución que se repite cada semana. Cada estudiante
                  tiene su propia asistencia.
                </p>
              </div>
              <Field label="Ver horario vigente al">
                <input
                  type="date"
                  min={data.period.start_date}
                  max={data.period.end_date}
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                />
              </Field>
            </div>
            <div className="schedule-grid">
              {days.map((day, index) => (
                <section key={day}>
                  <h3>{day}</h3>
                  {data.enrollments
                    .filter(
                      (e) =>
                        e.joined_on <= scheduleDate &&
                        (!e.left_on || e.left_on >= scheduleDate),
                    )
                    .flatMap((e) => {
                      const version = data.schedules
                        .filter(
                          (s) =>
                            s.enrollment_id === e.id &&
                            s.effective_from <= scheduleDate,
                        )
                        .sort((a, b) =>
                          b.effective_from.localeCompare(a.effective_from),
                        )[0];
                      return (version?.slots || [])
                        .filter((s) => s.day === index)
                        .map((s, i) => ({ e, s, key: `${e.id}/${i}` }));
                    })
                    .sort((a, b) => a.s.time.localeCompare(b.s.time))
                    .map(({ e, s, key }) => (
                      <button key={key} onClick={() => setScheduleModal(e)}>
                        <strong>{s.time}</strong>
                        <span>{e.full_name}</span>
                        <small>{data.book.duration_minutes} minutos</small>
                      </button>
                    ))}
                </section>
              ))}
            </div>
            <p className="hint">
              Selecciona un estudiante para cambiar su horario desde una fecha
              específica.
            </p>
          </>
        )}
      </section>
      {access?.kind === "admin" && (
        <button className="back-link" onClick={onAdmin}>
          <Settings size={16} /> Administrar este libro y sus suspensiones
        </button>
      )}
      {studentModal && (
        <StudentForm
          data={data}
          student={studentModal === "new" ? undefined : studentModal}
          onClose={() => setStudentModal(null)}
          onDone={() => void done()}
        />
      )}{" "}
      {scheduleModal && (
        <ScheduleForm
          data={data}
          student={scheduleModal}
          onClose={() => setScheduleModal(null)}
          onDone={() => void done()}
        />
      )}
    </main>
  );
}
function Admin({
  catalog,
  refresh,
  onClose,
}: {
  catalog: Catalog;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("suspensions"),
    [suspensions, setSuspensions] = useState<Suspension[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [scope, setScope] = useState("center"),
    [passwordKind, setPasswordKind] = useState("book");
  const load = () =>
    api("/admin")
      .then((v) => setSuspensions(v.suspensions))
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  async function save(value: unknown) {
    setNotice("");
    await api("/admin", value);
    await refresh();
    await load();
    setNotice("Cambios guardados.");
  }
  return (
    <main className="container admin-page">
      <button className="back-link" onClick={onClose}>
        <ArrowLeft size={17} /> Volver a los libros
      </button>
      <div className="section-heading">
        <div>
          <span className="eyebrow">CENTRO ARTÍSTICO CAC</span>
          <h1>Administración</h1>
          <p>Profesores, períodos lectivos y suspensiones.</p>
        </div>
        <ShieldCheck size={40} />
      </div>
      <div className="book-tabs">
        {[
          ["suspensions", "Suspensiones"],
          ["teachers", "Profesores"],
          ["periods", "Períodos"],
          ["books", "Duración de clases"],
          ["passwords", "Contraseñas"],
        ].map(([key, label]) => (
          <button
            className={tab === key ? "selected" : ""}
            key={key}
            onClick={() => {
              setTab(key);
              setNotice("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="admin-card">
        {notice && (
          <p className="success" role="status">
            <Check size={18} />
            {notice}
          </p>
        )}
        {error && <Alert>{error}</Alert>}
        {tab === "teachers" && (
          <>
            <h2>Profesores</h2>
            <p className="muted">
              El mismo profesor puede asociarse a varios libros.
            </p>
            <SubmitForm
              label="Agregar profesor"
              onSubmit={(f) => save({ action: "teacher", name: f.get("name") })}
            >
              <Field label="Nombre completo">
                <input name="name" required maxLength={120} />
              </Field>
            </SubmitForm>
            <ul className="simple-list">
              {catalog.teachers.map((t) => (
                <li key={t.id}>{t.name}</li>
              ))}
            </ul>
          </>
        )}
        {tab === "periods" && (
          <>
            <h2>Períodos lectivos</h2>
            <SubmitForm
              label="Crear período"
              onSubmit={(f) =>
                save({
                  action: "period",
                  name: f.get("name"),
                  start_date: f.get("start_date"),
                  end_date: f.get("end_date"),
                })
              }
            >
              <Field label="Nombre">
                <input
                  name="name"
                  placeholder="Período lectivo 2027"
                  required
                  maxLength={120}
                />
              </Field>
              <div className="two-fields">
                <Field label="Primer día">
                  <input type="date" name="start_date" required />
                </Field>
                <Field label="Último día">
                  <input type="date" name="end_date" required />
                </Field>
              </div>
            </SubmitForm>
            <ul className="simple-list">
              {catalog.periods.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong>
                  <span>
                    {p.start_date} — {p.end_date}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === "suspensions" && (
          <>
            <h2>Suspender clases</h2>
            <p className="muted">
              Estas sesiones no se cuentan como ausencias. Puedes indicar
              vacaciones, feriados o permisos.
            </p>
            <SubmitForm
              label="Registrar suspensión"
              onSubmit={(f) =>
                save({
                  action: "suspension",
                  scope,
                  target_id: scope === "center" ? null : f.get("target_id"),
                  start_date: f.get("start_date"),
                  end_date: f.get("end_date"),
                  reason: f.get("reason"),
                })
              }
            >
              <Field label="¿A quién afecta?">
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="center">Todo el CAC</option>
                  <option value="teacher">
                    Un profesor y todos sus libros
                  </option>
                  <option value="book">Un libro</option>
                </select>
              </Field>
              {scope !== "center" && (
                <Field label={scope === "teacher" ? "Profesor" : "Libro"}>
                  <select name="target_id" required key={scope}>
                    <option value="">Seleccionar…</option>
                    {scope === "teacher"
                      ? catalog.teachers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))
                      : catalog.books.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.discipline} · {b.teacher_name}
                          </option>
                        ))}
                  </select>
                </Field>
              )}
              <div className="two-fields">
                <Field label="Desde">
                  <input
                    type="date"
                    required
                    name="start_date"
                    defaultValue={localToday()}
                  />
                </Field>
                <Field label="Hasta (inclusive)">
                  <input
                    type="date"
                    required
                    name="end_date"
                    defaultValue={localToday()}
                  />
                </Field>
              </div>
              <Field label="Motivo">
                <input
                  name="reason"
                  required
                  maxLength={120}
                  placeholder="Por ejemplo, permiso del profesor"
                />
              </Field>
            </SubmitForm>
            <h3>Suspensiones registradas</h3>
            <ul className="simple-list">
              {suspensions.map((s) => (
                <li key={s.id}>
                  <div>
                    <strong>{s.reason}</strong>
                    <small>
                      {s.start_date} — {s.end_date}
                      <br />
                      {s.scope === "center"
                        ? "Todo el CAC"
                        : s.scope === "teacher"
                          ? catalog.teachers.find((t) => t.id === s.target_id)
                              ?.name
                          : catalog.books.find((b) => b.id === s.target_id)
                              ?.discipline}
                    </small>
                  </div>
                  <button
                    className="button small"
                    onClick={async () => {
                      if (
                        !confirm(
                          "¿Quitar esta suspensión? Las marcas de asistencia anteriores volverán a contar.",
                        )
                      )
                        return;
                      try {
                        await save({ action: "remove-suspension", id: s.id });
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === "books" && (
          <>
            <h2>Duración de las clases</h2>
            <SubmitForm
              onSubmit={(f) =>
                save({
                  action: "duration",
                  book_id: f.get("book_id"),
                  duration_minutes: Number(f.get("duration_minutes")),
                })
              }
            >
              <Field label="Libro">
                <select name="book_id" required>
                  <option value="">Seleccionar…</option>
                  {catalog.books.map((b) => (
                    <option value={b.id} key={b.id}>
                      {b.discipline} · {b.teacher_name} · {b.duration_minutes}{" "}
                      min
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Minutos por sesión">
                <input
                  type="number"
                  name="duration_minutes"
                  min={5}
                  max={480}
                  defaultValue={45}
                  required
                />
              </Field>
            </SubmitForm>
          </>
        )}
        {tab === "passwords" && (
          <>
            <h2>Restablecer contraseña</h2>
            <p className="muted">
              La nueva contraseña cierra los accesos anteriores de ese tipo.
              Administración y creación deben tener contraseñas distintas.
            </p>
            <SubmitForm
              onSubmit={async (f) => {
                await save({
                  action: "password",
                  kind: passwordKind,
                  book_id:
                    passwordKind === "book" ? f.get("book_id") : undefined,
                  password: f.get("password"),
                });
                if (passwordKind === "admin") {
                  window.location.reload();
                }
              }}
            >
              <Field label="Tipo de acceso">
                <select
                  value={passwordKind}
                  onChange={(e) => setPasswordKind(e.target.value)}
                >
                  <option value="book">Un libro</option>
                  <option value="creator">Crear libros</option>
                  <option value="admin">Administración</option>
                </select>
              </Field>
              {passwordKind === "book" && (
                <Field label="Libro">
                  <select name="book_id" required>
                    <option value="">Seleccionar…</option>
                    {catalog.books.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.discipline} · {b.teacher_name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Nueva contraseña">
                <input
                  type="password"
                  name="password"
                  required
                  minLength={6}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </Field>
            </SubmitForm>
          </>
        )}
      </section>
    </main>
  );
}
export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [access, setAccess] = useState<Access | null>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState("home"),
    [selected, setSelected] = useState<Book | null>(null),
    [dialog, setDialog] = useState<Access["kind"] | null>(null),
    [create, setCreate] = useState(false),
    [filter, setFilter] = useState("");
  async function refresh() {
    const c = await api<Catalog>("/catalog");
    setCatalog(c);
  }
  useEffect(() => {
    Promise.all([api<Catalog>("/catalog"), api<Access | null>("/session")])
      .then(([c, a]) => {
        setCatalog(c);
        setAccess(a);
        const bookId = window.location.hash.replace("#book/", "");
        if (window.location.hash.startsWith("#book/")) {
          const b = c.books.find((b) => b.id === bookId);
          if (b) {
            setSelected(b);
            if (a?.kind === "admin" || a?.book_id === b.id) setPage("book");
            else setDialog("book");
          }
        }
      })
      .catch((e) => setError(e.message));
  }, []);
  function openBook(b: Book) {
    setSelected(b);
    if (access?.kind === "admin" || access?.book_id === b.id) {
      setPage("book");
      window.location.hash = `book/${b.id}`;
    } else setDialog("book");
  }
  function onLogin(a: Access) {
    setAccess(a);
    const requested = dialog;
    setDialog(null);
    if (requested === "book") {
      setPage("book");
      window.location.hash = `book/${selected!.id}`;
    } else if (requested === "admin") setPage("admin");
    else setCreate(true);
  }
  async function logout() {
    try {
      await api("/logout", {});
      setAccess(null);
      setPage("home");
      window.location.hash = "";
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <header className="topbar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setPage("home");
            window.location.hash = "";
          }}
        >
          <img
            className="cac-logo monochrome-logo"
            src="/brand/cac-original.jpg"
            alt="CAC · Centro Artístico Cultural Concepción"
          />
          <span className="brand-caption">Registro de asistencia</span>
        </a>
        <div className="top-actions">
          {catalog?.environment !== "production" && catalog && (
            <span className="demo-badge">Datos de demostración</span>
          )}
          <button
            className="admin-link"
            onClick={() =>
              access?.kind === "admin" ? setPage("admin") : setDialog("admin")
            }
          >
            <Settings size={17} />
            <span>Administración</span>
          </button>
          {access && (
            <button className="button small" onClick={() => void logout()}>
              <LogOut size={16} /> Salir
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="container">
          <Alert>{error}</Alert>
          <button className="button" onClick={() => window.location.reload()}>
            Reintentar conexión
          </button>
        </div>
      )}
      {!catalog && !error && (
        <main className="container">
          <p>Cargando los libros del CAC…</p>
        </main>
      )}
      {catalog && page === "home" && (
        <main className="container home">
          <section className="home-intro">
            <div>
              <div className="eyebrow">
                CENTRO ARTÍSTICO CULTURAL CONCEPCIÓN
              </div>
              <h1>Libros de clases</h1>
              <p>
                Consulta tus cursos y registra la asistencia de cada semana.
              </p>
            </div>
          </section>
          <section className="library">
            <div className="library-heading">
              <div>
                <h2>
                  Cursos y talleres <span>{catalog.books.length}</span>
                </h2>
                <p>Elige tu libro para registrar la asistencia.</p>
              </div>
              <button
                className="button primary"
                onClick={() =>
                  ["admin", "creator"].includes(access?.kind || "")
                    ? setCreate(true)
                    : setDialog("creator")
                }
              >
                <Plus size={19} /> Crear un libro
              </button>
            </div>
            <div className="library-filters">
              <span className="filter-label">
                <BookOpen size={17} /> Todos los libros
              </span>
              <div className="search-field">
                <Search size={17} />
                <input
                  aria-label="Buscar libro o profesor"
                  placeholder="Buscar disciplina o profesor…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            </div>
            <div className="books-grid">
              {catalog.books
                .filter((b) =>
                  `${b.discipline} ${b.teacher_name}`
                    .toLocaleLowerCase("es")
                    .includes(filter.toLocaleLowerCase("es")),
                )
                .map((b, i) => (
                  <button
                    className={`book-card palette-${i % 4}`}
                    key={b.id}
                    onClick={() => openBook(b)}
                  >
                    <div className="book-spine" />
                    <div className="book-cover">
                      <div className="cover-top">
                        <img
                          className="cover-logo monochrome-logo"
                          src="/brand/cac-original.jpg"
                          alt="CAC"
                        />
                        <span>LIBRO DE CLASES</span>
                        <LockKeyhole size={17} />
                      </div>
                      <h3>{b.discipline}</h3>
                      <p>{b.teacher_name}</p>
                      <div className="cover-bottom">
                        <span>{b.period_name}</span>
                        <span>
                          {b.sessions_per_week}{" "}
                          {b.sessions_per_week > 1 ? "sesiones" : "sesión"} /
                          semana
                        </span>
                      </div>
                      <div className="cover-decoration" />
                    </div>
                    <div className="book-pages" />
                    <div className="book-open">
                      <span>Abrir libro</span>
                      <span>↗</span>
                    </div>
                  </button>
                ))}
            </div>
            {!catalog.books.length && (
              <div className="empty-state">
                <BookOpen size={34} />
                <h3>No hay libros registrados</h3>
                <p>
                  Administración puede agregar profesores y períodos. Luego,
                  cada profesor crea su libro.
                </p>
              </div>
            )}
            {catalog.books.length > 0 &&
              !catalog.books.some((b) =>
                `${b.discipline} ${b.teacher_name}`
                  .toLocaleLowerCase("es")
                  .includes(filter.toLocaleLowerCase("es")),
              ) && (
                <p className="empty-state">
                  No hay libros que coincidan con tu búsqueda.
                </p>
              )}
          </section>
          <aside className="home-note">
            <span className="note-icon">
              <ShieldCheck size={24} />
            </span>
            <div>
              <strong>Acceso a los libros</strong>
              <p>
                Ingresa con tu contraseña. Si necesitas ayuda, acércate a
                administración.
              </p>
            </div>
          </aside>
        </main>
      )}
      {catalog && page === "book" && selected && (
        <BookView
          key={selected.id}
          bookId={selected.id}
          access={access}
          onBack={() => {
            setPage("home");
            window.location.hash = "";
          }}
          onAdmin={() => setPage("admin")}
        />
      )}{" "}
      {catalog && page === "admin" && access?.kind === "admin" && (
        <Admin
          catalog={catalog}
          refresh={refresh}
          onClose={() => setPage("home")}
        />
      )}
      <footer className="footer">
        <span>Centro Artístico Cultural Concepción</span>
        <span>Registro de asistencia</span>
      </footer>
      {dialog && (
        <PasswordDialog
          kind={dialog}
          book={selected || undefined}
          onClose={() => setDialog(null)}
          onLogin={onLogin}
        />
      )}{" "}
      {create && catalog && (
        <CreateBook
          catalog={catalog}
          onClose={() => setCreate(false)}
          onDone={async (id) => {
            setCreate(false);
            await refresh();
            setAccess(null);
            const c = await api<Catalog>("/catalog");
            const b = c.books.find((b) => b.id === id);
            if (b) {
              setSelected(b);
              setDialog("book");
            }
          }}
        />
      )}
    </>
  );
}
