import {
  MessageCircle,
  Minus,
  Send,
  SlidersHorizontal,
  Music2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Book, Teacher } from "./domain";
type Result = {
  text: string;
  from: string;
  to: string;
  source: string;
  warning: string;
  generated_at: string;
  usage: { used: number; limit: number };
  rows: Record<string, string | number | null>[];
  summary?: { pending: number; suspended: number };
  comparison?: {
    from: string;
    to: string;
    percentage: number | null;
    count: number;
  } | null;
};
export function MacaAssistant({
  books,
  teachers,
}: {
  books: Book[];
  teachers: Teacher[];
}) {
  const [messages, setMessages] = useState<
      { question: string; result: Result; filters: string }[]
    >([]),
    [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [book, setBook] = useState(""),
    [teacher, setTeacher] = useState("");
  const sending = useRef(false);
  const [open, setOpen] = useState(false),
    [showFilters, setShowFilters] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null),
    logRef = useRef<HTMLDivElement>(null),
    launcherRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open && logRef.current)
      logRef.current.scrollTo({
        top: logRef.current.scrollHeight,
        behavior: "smooth",
      });
  }, [messages, busy, open]);
  function minimize() {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }

  async function send(text = question) {
    if (sending.current || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<Result>("/admin/maca", {
        question: text,
        request_id: crypto.randomUUID(),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(book ? { book_id: book } : {}),
        ...(teacher ? { teacher_id: teacher } : {}),
      });
      const selectedBook = books.find((b) => b.id === book);
      const filters = [
        selectedBook
          ? `${selectedBook.teacher_name} · ${selectedBook.discipline}`
          : "Todos los libros",
        teachers.find((t) => t.id === teacher)?.name || "Todos los profesores",
      ].join(" / ");
      setMessages((m) => [
        ...m.slice(-19),
        { question: text, result, filters },
      ]);
      setQuestion("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo consultar.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="maca-dock">
      <button
        ref={launcherRef}
        className="maca-launcher"
        hidden={open}
        aria-label="Abrir chat con Maca"
        aria-expanded={open}
        aria-controls="maca-chat"
        onClick={() => setOpen(true)}
      >
        <span className="maca-avatar">
          <Music2 size={18} />
        </span>
        <span>
          Maca<span className="maca-launcher-caption">Asistente CAC</span>
        </span>
        {busy ? (
          <span className="maca-dot maca-dot-busy" aria-label="Consultando" />
        ) : (
          <MessageCircle size={18} />
        )}
      </button>
      <section
        id="maca-chat"
        className="maca-window"
        hidden={!open}
        aria-label="Chat con Maca"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            minimize();
          }
        }}
      >
        <header className="maca-header">
          <span className="maca-avatar">
            <Music2 size={18} />
          </span>
          <div>
            <h2>Maca</h2>
            <span>Tu asistente del CAC</span>
          </div>
          <button
            type="button"
            aria-label="Minimizar chat de Maca"
            onClick={minimize}
          >
            <Minus size={19} />
          </button>
        </header>
        <div className="maca-toolbar">
          <button
            type="button"
            aria-expanded={showFilters}
            aria-controls="maca-filters"
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal size={14} /> Filtros
            {(from || to || book || teacher) && <span className="maca-dot" />}
          </button>
          <button
            type="button"
            aria-label="Limpiar conversación"
            title="Limpiar conversación"
            disabled={busy || !messages.length}
            onClick={() => {
              setMessages([]);
              setError("");
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        {showFilters && (
          <div className="maca-filters" id="maca-filters">
            <label>
              Desde
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              Hasta
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label>
              Libro
              <select value={book} onChange={(e) => setBook(e.target.value)}>
                <option value="">Todos</option>
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.teacher_name} · {b.discipline}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Profesor
              <select
                value={teacher}
                onChange={(e) => setTeacher(e.target.value)}
              >
                <option value="">Todos</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <small>Para filtrar por nombre, usa estos selectores.</small>
          </div>
        )}
        <div
          ref={logRef}
          className="maca-conversation"
          role="log"
          aria-label="Conversación con Maca"
          aria-live="polite"
          aria-relevant="additions text"
        >
          <div className="maca-bubble maca-welcome">
            <p>
              ¡Hola! Soy Maca 🎵 Tú pones las preguntas; yo llevo el compás de
              los números del CAC.
            </p>
          </div>
          {messages.length === 0 && !busy && (
            <div className="maca-suggestions">
              {[
                ["Asistencia de hoy", "¿Cuántas clases se registraron hoy?"],
                [
                  "Libros pendientes",
                  "¿Qué libros tienen registros pendientes hoy?",
                ],
                [
                  "Cambios por aprobar",
                  "¿Cuántos cambios de horario esperan aprobación?",
                ],
              ].map(([label, q]) => (
                <button type="button" key={label} onClick={() => send(q)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <article key={i} className="maca-exchange">
              <div className="maca-bubble maca-user">
                <span className="sr-only">Tú: </span>
                {m.question}
              </div>
              <div className="maca-bubble maca-reply">
                <p>
                  <span className="sr-only">Maca: </span>
                  {m.result.text}
                </p>
                {m.result.summary && (
                  <p className="maca-summary">
                    <strong>{m.result.summary.pending}</strong> pendientes ·{" "}
                    <strong>{m.result.summary.suspended}</strong> suspendidas
                  </p>
                )}
                {m.result.rows.length > 0 && (
                  <div className="table-scroll">
                    <table className="plain-table">
                      <thead>
                        <tr>
                          {Object.keys(m.result.rows[0]).map((k) => (
                            <th key={k}>{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {m.result.rows.map((row, j) => (
                          <tr key={j}>
                            {Object.entries(row).map(([k, v]) => (
                              <td key={k}>{v ?? "Sin registros"}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {m.result.comparison && (
                  <p>
                    Período anterior ({m.result.comparison.from} al{" "}
                    {m.result.comparison.to}): {m.result.comparison.count}{" "}
                    registradas,{" "}
                    {m.result.comparison.percentage ?? "sin registros"} %.
                  </p>
                )}
                <details className="maca-result-details">
                  <summary>Período y detalle</summary>
                  <p>
                    {m.result.from} al {m.result.to} · America/Santiago
                  </p>
                  <p>{m.filters}</p>
                  <p>{m.result.source}</p>
                  <p>{m.result.warning}</p>
                  <p>
                    Consultado:{" "}
                    {new Date(m.result.generated_at).toLocaleString("es-CL", {
                      timeZone: "America/Santiago",
                    })}
                  </p>
                  <p>
                    Uso diario: {m.result.usage.used}/{m.result.usage.limit}
                  </p>
                </details>
              </div>
            </article>
          ))}
          {busy && (
            <div className="maca-bubble maca-processing" role="status">
              Estoy afinando los números<span aria-hidden="true">…</span>
            </div>
          )}
          {error && (
            <p role="alert" className="maca-chat-error">
              {error}
            </p>
          )}
        </div>
        <form
          className="maca-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="maca-question" className="sr-only">
            Pregunta institucional
          </label>
          <textarea
            ref={inputRef}
            id="maca-question"
            placeholder="Escríbele a Maca…"
            rows={1}
            maxLength={600}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            required
            disabled={busy}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            aria-label="Enviar pregunta a Maca"
            disabled={busy || !question.trim()}
          >
            <Send size={18} />
          </button>
        </form>
        <div className="maca-footnote">
          Solo consulta · Conversación temporal
        </div>
      </section>
    </div>
  );
}
