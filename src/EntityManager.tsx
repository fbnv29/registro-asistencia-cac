import { useEffect, useRef, useState } from "react";
import type { Book, Teacher, Period } from "./domain";
import { markDraft, confirmLeave } from "./drafts";
type Entity = "teacher" | "period" | "book";
export default function EntityManager({
  catalog,
  save,
}: {
  catalog: { books: Book[]; teachers: Teacher[]; periods: Period[] };
  save: (v: unknown) => Promise<void>;
}) {
  const [edit, setEdit] = useState<{ entity: Entity; row: any } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const draft = useRef({});
  useEffect(() => () => markDraft(draft.current, false), []);
  async function submit(v: unknown) {
    setBusy(true);
    setError("");
    try {
      await save(v);
      markDraft(draft.current, false);
      setEdit(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>Editar y archivar</h2>
      <p>
        Archivar conserva el historial. Los libros y períodos archivados
        permiten solo consulta y exportación.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {edit && (
        <form
          className="entity-editor"
          key={edit.row.id}
          onChange={() => markDraft(draft.current, true)}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void submit({
              action: `edit-${edit.entity}`,
              id: edit.row.id,
              ...Object.fromEntries(f),
            });
          }}
        >
          <h3>
            Editar{" "}
            {edit.entity === "teacher"
              ? "profesor"
              : edit.entity === "period"
                ? "período"
                : "libro"}
          </h3>
          <label>
            {edit.entity === "book" ? "Disciplina" : "Nombre"}
            <input
              name={edit.entity === "book" ? "discipline" : "name"}
              defaultValue={edit.row.discipline || edit.row.name}
              required
              maxLength={120}
            />
          </label>
          {edit.entity === "book" && (
            <label>
              Profesor
              <select name="teacher_id" defaultValue={edit.row.teacher_id}>
                {catalog.teachers
                  .filter((t) => !t.archived_at || t.id === edit.row.teacher_id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.archived_at ? " (archivado)" : ""}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {edit.entity === "period" && (
            <>
              <label>
                Desde
                <input
                  type="date"
                  name="start_date"
                  defaultValue={edit.row.start_date}
                  required
                />
              </label>
              <label>
                Hasta
                <input
                  type="date"
                  name="end_date"
                  defaultValue={edit.row.end_date}
                  required
                />
              </label>
            </>
          )}
          <button className="button primary" disabled={busy}>
            Guardar cambios
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              if (confirmLeave()) {
                markDraft(draft.current, false);
                setEdit(null);
              }
            }}
          >
            Cancelar
          </button>
        </form>
      )}
      {(["teacher", "period", "book"] as const).map((entity) => (
        <section key={entity}>
          <h3>
            {entity === "teacher"
              ? "Profesores"
              : entity === "period"
                ? "Períodos"
                : "Libros"}
          </h3>
          <div className="table-scroll">
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {(entity === "teacher"
                  ? catalog.teachers
                  : entity === "period"
                    ? catalog.periods
                    : catalog.books
                ).map((row: any) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.discipline || row.name}
                      {entity === "book" && <small> · {row.period_name}</small>}
                    </th>
                    <td>
                      {row.archived_at
                        ? "Archivado"
                        : row.period_archived_at
                          ? "Período archivado"
                          : "Activo"}
                    </td>
                    <td>
                      <button
                        className="button"
                        disabled={
                          busy || !!row.archived_at || !!row.period_archived_at
                        }
                        onClick={() => {
                          if (confirmLeave()) {
                            markDraft(draft.current, false);
                            setEdit({ entity, row });
                          }
                        }}
                      >
                        Editar
                      </button>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirmLeave() &&
                            window.confirm(
                              `${row.archived_at ? "¿Restaurar" : "¿Archivar"} ${row.discipline || row.name}? El historial se conserva.`,
                            )
                          )
                            void submit({
                              action: "archive",
                              entity,
                              id: row.id,
                              archived: !row.archived_at,
                            });
                        }}
                      >
                        {row.archived_at ? "Restaurar" : "Archivar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
