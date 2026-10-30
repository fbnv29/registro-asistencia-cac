import { useEffect, useState } from "react";
import { Plus, Check, X, Clock3 } from "lucide-react";
import { api } from "./api";
import {
  days,
  shortDate,
  type Slot,
  type Enrollment,
  type Schedule,
} from "./domain";
interface ChangeRequest {
  id: string;
  book_id: string;
  kind: "student.create" | "student.update" | "schedule.update" | "book.create";
  status: "pending" | "approved" | "rejected";
  discipline: string;
  teacher_name: string;
  submitted_at: string;
  reviewed_at: string | null;
  review_note: string;
  payload: {
    full_name?: string;
    enrollment_id?: string;
    joined_on?: string;
    left_on?: string | null;
    slots?: Slot[];
    effective_from?: string;
    discipline?: string;
    sessions_per_week?: number;
  };
  base_state: { enrollment?: Enrollment; schedules?: Schedule[] } | null;
}
const titles = {
  "student.create": "Agregar estudiante",
  "student.update": "Modificar ficha o retiro",
  "schedule.update": "Cambiar horario",
  "book.create": "Crear libro",
};
const states = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
};
const dateTime = (value: string) =>
  new Intl.DateTimeFormat("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Santiago",
  }).format(new Date(value));
function SlotSummary({ slots }: { slots?: Slot[] }) {
  return (
    <>
      {slots?.map((slot, index) => (
        <span className="request-slot" key={index}>
          {days[slot.day]} · {slot.time}
        </span>
      ))}
    </>
  );
}
function Details({ request: r }: { request: ChangeRequest }) {
  const p = r.payload;
  const previous = r.base_state?.schedules
    ?.filter((s) => s.effective_from <= (p.effective_from || "9999"))
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
    .at(-1);
  return (
    <div className="request-details">
      {r.kind === "book.create" ? (
        <>
          <strong>{p.discipline}</strong>
          <span>{p.sessions_per_week} sesiones semanales</span>
          <small>
            La contraseña del nuevo libro se guarda protegida y no se muestra en
            la solicitud.
          </small>
        </>
      ) : (
        <>
          <strong>
            {p.full_name ||
              r.base_state?.enrollment?.full_name ||
              "Estudiante del libro"}
          </strong>
          {r.kind === "student.create" && p.joined_on && (
            <span>Ingreso: {shortDate(p.joined_on)}</span>
          )}
          {r.kind === "student.update" && r.base_state?.enrollment && (
            <div className="request-comparison">
              <div>
                <small>Actual</small>
                <span>{r.base_state.enrollment.full_name}</span>
                <span>
                  {r.base_state.enrollment.left_on
                    ? `Retiro: ${shortDate(r.base_state.enrollment.left_on)}`
                    : "Sin retiro"}
                </span>
              </div>
              <div>
                <small>Propuesto</small>
                <span>{p.full_name}</span>
                <span>
                  {p.left_on ? `Retiro: ${shortDate(p.left_on)}` : "Sin retiro"}
                </span>
              </div>
            </div>
          )}
          {r.kind === "schedule.update" ? (
            <>
              <span>
                Aplicar desde{" "}
                {p.effective_from
                  ? shortDate(p.effective_from)
                  : "fecha indicada"}
              </span>
              <div className="request-comparison">
                <div>
                  <small>Horario actual</small>
                  <SlotSummary slots={previous?.slots} />
                </div>
                <div>
                  <small>Horario propuesto</small>
                  <SlotSummary slots={p.slots} />
                </div>
              </div>
            </>
          ) : (
            <SlotSummary slots={p.slots} />
          )}
        </>
      )}
    </div>
  );
}
export default function RequestList({
  bookId,
  admin = false,
  version = 0,
  onReviewed,
  onRefresh,
  onProposeBook,
}: {
  bookId?: string;
  admin?: boolean;
  version?: number;
  onReviewed?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
  onProposeBook?: () => void;
}) {
  const [requests, setRequests] = useState<ChangeRequest[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [filter, setFilter] = useState(admin ? "pending" : "all"),
    [busy, setBusy] = useState(""),
    [notes, setNotes] = useState<Record<string, string>>({});
  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ requests: ChangeRequest[] }>(
        admin ? "/admin/requests" : `/books/${bookId}/requests`,
      );
      setRequests(result.requests);
      await onRefresh?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [bookId, admin, version]);
  async function review(r: ChangeRequest, decision: "approve" | "reject") {
    setBusy(r.id);
    setError("");
    try {
      await api(`/admin/requests/${r.id}`, {
        decision,
        note: notes[r.id] || "",
      });
      await load();
      await onReviewed?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const visible = requests.filter(
    (r) => filter === "all" || r.status === filter,
  );
  return (
    <section className="requests-panel">
      <div className="section-heading">
        <div>
          <h2>{admin ? "Pendientes por aprobar" : "Mis solicitudes"}</h2>
          <p>
            {admin
              ? "Revisa las propuestas de los profesores. Aprobar aplica el cambio al libro; rechazar conserva los datos actuales."
              : "Los cambios de estudiantes, horarios y libros requieren confirmación de administración. La asistencia se guarda directamente."}
          </p>
        </div>
        <div className="request-top-actions">
          {onProposeBook && (
            <button className="button primary" onClick={onProposeBook}>
              <Plus size={17} /> Proponer nuevo libro
            </button>
          )}
          <button
            className="button small"
            disabled={loading || !!busy}
            onClick={() => void load()}
          >
            Actualizar
          </button>
        </div>
      </div>
      <div className="request-filters">
        <label className="field">
          <span>Mostrar solicitudes</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="pending">
              Pendientes (
              {requests.filter((r) => r.status === "pending").length})
            </option>
            <option value="approved">Aprobadas</option>
            <option value="rejected">Rechazadas</option>
            <option value="all">Todas</option>
          </select>
        </label>
        <span>
          {requests.filter((r) => r.status === "pending").length} pendientes de
          revisión
        </span>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p role="status">Cargando solicitudes…</p>
      ) : !visible.length ? (
        <p className="empty-state">No hay solicitudes en esta vista.</p>
      ) : (
        <div className="request-list">
          {visible.map((r) => (
            <article className="request-card" key={r.id}>
              <div className="request-card-heading">
                <div>
                  <h3>{titles[r.kind]}</h3>
                  <p>
                    {r.discipline} · {r.teacher_name}
                  </p>
                  <small>Enviada el {dateTime(r.submitted_at)}</small>
                </div>
                <span className={`request-status ${r.status}`}>
                  {r.status === "pending" ? (
                    <Clock3 size={14} />
                  ) : r.status === "approved" ? (
                    <Check size={14} />
                  ) : (
                    <X size={14} />
                  )}{" "}
                  {states[r.status]}
                </span>
              </div>
              <Details request={r} />
              {r.review_note && (
                <p className="review-note">
                  <strong>Administración:</strong> {r.review_note}
                </p>
              )}
              {r.reviewed_at && (
                <small className="reviewed-at">
                  Revisada el {dateTime(r.reviewed_at)}
                </small>
              )}
              {r.status === "approved" && r.kind === "book.create" && (
                <p className="hint">
                  El libro aprobado está disponible en la portada.
                </p>
              )}
              {admin && r.status === "pending" && (
                <div className="request-review">
                  <label className="field">
                    <span>Observación para el profesor (opcional)</span>
                    <input
                      maxLength={500}
                      value={notes[r.id] || ""}
                      onChange={(e) =>
                        setNotes((v) => ({ ...v, [r.id]: e.target.value }))
                      }
                      placeholder="Indica una corrección o el motivo del rechazo"
                    />
                  </label>
                  <div className="request-review-buttons">
                    <button
                      className="button primary"
                      disabled={!!busy}
                      onClick={() => void review(r, "approve")}
                    >
                      <Check size={17} />
                      {busy === r.id ? "Procesando…" : "Aprobar y aplicar"}
                    </button>
                    <button
                      className="button"
                      disabled={!!busy}
                      onClick={() => void review(r, "reject")}
                    >
                      <X size={17} /> Rechazar
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
