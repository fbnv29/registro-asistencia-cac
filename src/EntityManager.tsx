import { confirmPermanentDelete } from "./permanentDelete";
import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import type { Book, Teacher, Period } from "./domain";
import { markDraft, confirmLeave } from "./drafts";
type Entity = "teacher" | "period" | "book";
export default function EntityManager({
  catalog,
  save,
  teachersOnly = false,
}: {
  teachersOnly?: boolean;
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
      {!teachersOnly && <h2>Editar, archivar y eliminar</h2>}
      <p>
        Archivar un profesor conserva sus libros e historial y lo excluye de
        nuevas asignaciones. Los libros y períodos archivados permiten solo
        consulta y exportación.
      </p>
      {error && !edit && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {edit && (
        <Modal
          title={`Editar ${edit.entity === "teacher" ? "profesor" : edit.entity === "period" ? "período" : "libro"}`}
          onClose={() => {
            if (!busy) {
              markDraft(draft.current, false);
              setEdit(null);
            }
          }}
        >
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
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
                    .filter(
                      (t) => !t.archived_at || t.id === edit.row.teacher_id,
                    )
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
              disabled={busy}
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
        </Modal>
      )}
      {(teachersOnly
        ? (["teacher"] as const)
        : (["teacher", "period", "book"] as const)
      ).map((entity) => (
        <section key={entity}>
          {!teachersOnly && (
            <h3>
              {entity === "teacher"
                ? "Profesores"
                : entity === "period"
                  ? "Períodos"
                  : "Libros"}
            </h3>
          )}
          <div className="table-scroll">
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  {entity === "teacher" && (
                    <>
                      <th>Disciplinas / libros</th>
                      <th>Total de libros</th>
                    </>
                  )}
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
                    {entity === "teacher" && (
                      <td>
                        {catalog.books
                          .filter((b) => b.teacher_id === row.id)
                          .map((b) => (
                            <div className="teacher-discipline" key={b.id}>
                              <strong>{b.discipline}</strong>
                              <small>{b.period_name}</small>
                            </div>
                          ))}
                        {!catalog.books.some((b) => b.teacher_id === row.id) &&
                          "Sin libros asignados"}
                      </td>
                    )}
                    {entity === "teacher" && (
                      <td>
                        {
                          catalog.books.filter((b) => b.teacher_id === row.id)
                            .length
                        }
                      </td>
                    )}
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
                            setError("");
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
                      {entity !== "period" && (
                        <button
                          className="button danger"
                          disabled={busy}
                          onClick={() => {
                            if (
                              confirmLeave() &&
                              confirmPermanentDelete(
                                row.discipline || row.name,
                                entity === "book"
                                  ? "Se eliminarán todas sus matrículas, horarios, asistencias y solicitudes. Las fichas de estudiantes se conservan."
                                  : "Solo se puede borrar un profesor sin libros asignados.",
                              )
                            )
                              void submit({
                                action: "delete-permanently",
                                entity,
                                id: row.id,
                                confirmed: true,
                                confirmation: "ELIMINAR",
                              });
                          }}
                        >
                          Borrar definitivamente
                        </button>
                      )}
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
