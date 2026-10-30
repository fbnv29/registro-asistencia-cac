import { useRef, useState } from "react";
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
    <div className="maca">
      <h2>🤖 Maca Asistente</h2>
      <p>
        Hola, soy Maca. Puedo analizar asistencia, pendientes, suspensiones y
        cambios de horario del CAC. Solo consulto datos; no modifico registros.
      </p>
      <p className="muted">
        Historial temporal en esta pestaña. Los nombres escritos en el chat no
        se usan como filtros: selecciona el libro o profesor aquí.
      </p>
      <div className="maca-filters">
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
          <select value={teacher} onChange={(e) => setTeacher(e.target.value)}>
            <option value="">Todos</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="maca-suggestions">
        {[
          "¿Cuántas clases se registraron esta semana?",
          "¿Qué libros tienen registros pendientes hoy?",
          "¿Cuántos cambios de horario esperan aprobación?",
          "¿Cómo evolucionó la asistencia durante el semestre?",
          "Comparar asistencia del mes anterior",
        ].map((q) => (
          <button key={q} disabled={busy} onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>
      <div role="log" aria-label="Conversación con Maca" aria-live="polite">
        {messages.map((m, i) => (
          <article key={i} className="maca-message">
            <p>
              <strong>Tú:</strong> {m.question}
            </p>
            <p>
              <strong>Maca:</strong> {m.result.text}
            </p>
            <p>
              {m.result.from} al {m.result.to} · America/Santiago ·{" "}
              {m.result.source}
            </p>
            <p>Filtros: {m.filters}</p>
            {m.result.summary && (
              <p>
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
                registradas, {m.result.comparison.percentage ?? "sin registros"}{" "}
                %.
              </p>
            )}
            <small>
              {m.result.warning} Consultado:{" "}
              {new Date(m.result.generated_at).toLocaleString("es-CL", {
                timeZone: "America/Santiago",
              })}
              . Uso diario: {m.result.usage.used}/{m.result.usage.limit}.
            </small>
          </article>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {busy && <p role="status">Maca está consultando…</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="maca-question">Pregunta institucional</label>
        <textarea
          id="maca-question"
          maxLength={600}
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          required
          disabled={busy}
        />
        <button type="submit" disabled={busy || !question.trim()}>
          Consultar
        </button>
        <button type="button" disabled={busy} onClick={() => setMessages([])}>
          Limpiar conversación
        </button>
      </form>
    </div>
  );
}
