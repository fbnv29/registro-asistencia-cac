import "dotenv/config";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { transaction, closeDatabase } from "../server/db";
import { hashPassword } from "../server/security";
const teacher = randomUUID(),
  period = randomUUID(),
  book = randomUUID(),
  student = randomUUID(),
  enrollment = randomUUID();
let proposalStudent: string;
test.beforeAll(async () => {
  if (!["development", "preview"].includes(process.env.APP_ENV || ""))
    throw new Error("Solo desarrollo.");
  await transaction(async (c) => {
    await c.query(
      "INSERT INTO teachers(id,name) VALUES($1,'Profesor navegador')",
      [teacher],
    );
    await c.query(
      "INSERT INTO periods(id,name,start_date,end_date) VALUES($1,'Piloto navegador','2026-03-01','2026-11-30')",
      [period],
    );
    await c.query(
      "INSERT INTO books(id,teacher_id,period_id,discipline,sessions_per_week,password_hash) VALUES($1,$2,$3,$4,1,$5)",
      [
        book,
        teacher,
        period,
        `Piloto ${book.slice(0, 8)}`,
        await hashPassword("browser-test-password"),
      ],
    );
    await c.query(
      "INSERT INTO students(id,full_name) VALUES($1,'Estudiante navegador')",
      [student],
    );
    await c.query(
      "INSERT INTO enrollments(id,student_id,book_id,joined_on) VALUES($1,$2,$3,'2026-03-01')",
      [enrollment, student, book],
    );
    await c.query(
      `INSERT INTO schedule_versions(id,enrollment_id,effective_from,slots) VALUES($1,$2,'2026-03-01','[{"day":0,"time":"15:00"}]')`,
      [randomUUID(), enrollment],
    );
  });
});
test.afterAll(async () => {
  await transaction(async (c) => {
    const members = (
      await c.query("SELECT student_id FROM enrollments WHERE book_id=$1", [
        book,
      ])
    ).rows;
    await c.query("SELECT id FROM books WHERE id=$1 FOR UPDATE", [book]);
    await c.query("DELETE FROM change_requests WHERE book_id=$1", [book]);
    await c.query("DELETE FROM access_sessions WHERE book_id=$1", [book]);
    await c.query(
      "DELETE FROM attendance WHERE lesson_id IN(SELECT l.id FROM lessons l JOIN enrollments e ON e.id=l.enrollment_id WHERE e.book_id=$1)",
      [book],
    );
    await c.query(
      "DELETE FROM lessons WHERE enrollment_id IN(SELECT id FROM enrollments WHERE book_id=$1)",
      [book],
    );
    await c.query(
      "DELETE FROM schedule_versions WHERE enrollment_id IN(SELECT id FROM enrollments WHERE book_id=$1)",
      [book],
    );
    await c.query("DELETE FROM enrollments WHERE book_id=$1", [book]);
    for (const m of members)
      await c.query("DELETE FROM students WHERE id=$1", [m.student_id]);
    await c.query("DELETE FROM books WHERE id=$1", [book]);
    await c.query("DELETE FROM periods WHERE id=$1", [period]);
    await c.query("DELETE FROM teachers WHERE id=$1", [teacher]);
  });
  await closeDatabase();
});
async function login(page: any) {
  await page.goto(`/#book/${book}`);
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: `Piloto ${book.slice(0, 8)}`,
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
}
test("propuesta, aprobación, nota, asistencia, fallas, sesión vencida y archivo", async ({
  page,
  context,
  request,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Agregar estudiante", exact: true })
    .click();
  proposalStudent = `Propuesto ${book.slice(0, 8)}`;
  await page
    .getByLabel("Nombre completo", { exact: true })
    .fill(proposalStudent);
  await page.getByLabel("Hora", { exact: true }).fill("16:00");
  await page
    .getByRole("button", { name: "Enviar solicitud", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Admin approval uses a separate HTTP session, keeping the teacher browser restricted.
  const origin = "http://127.0.0.1:5173";
  const admin = await request.post("/api/login", {
    headers: { Origin: origin },
    data: { kind: "admin", password: process.env.CAC_ADMIN_PASSWORD },
  });
  expect(admin.ok()).toBeTruthy();
  const queue = await (await request.get("/api/admin/requests")).json();
  const proposed = queue.requests.find(
    (r: any) => r.book_id === book && r.status === "pending",
  );
  expect(proposed).toBeTruthy();
  const approved = await request.post(`/api/admin/requests/${proposed.id}`, {
    headers: { Origin: origin },
    data: { decision: "approve", note: "Prueba navegador" },
  });
  expect(approved.ok()).toBeTruthy();
  // request shares cookies with context; log teacher back in without reloading the book.
  await request.post("/api/login", {
    headers: { Origin: origin },
    data: { kind: "book", book_id: book, password: "browser-test-password" },
  });
  await page.reload();
  await page.getByRole("tab", { name: "Estudiantes", exact: true }).click();
  await expect(page.getByText(proposalStudent, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nota", exact: true }).first().click();
  await page
    .getByLabel("Nota breve", { exact: true })
    .fill("Le gusta la música rock");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(page.getByLabel("Nota breve", { exact: true })).toHaveValue(
    "Le gusta la música rock",
  );
  await page.getByRole("button", { name: "Guardar nota", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Asistencia", exact: true }).click();
  const cell = page.getByRole("combobox", {
    name: "Estudiante navegador, 2026-03-02, sesión 1",
    exact: true,
  });
  await cell.selectOption("present");
  await expect(
    page.getByText("Cambios guardados", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(cell).toHaveValue("present");
  await page.route(`**/api/books/${book}/attendance`, (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "Servidor no disponible",
    }),
  );
  await cell.selectOption("absent");
  await expect(
    page.getByText(
      "El servidor devolvió una respuesta inesperada. Vuelve a intentarlo.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.unroute(`**/api/books/${book}/attendance`);
  await page.getByRole("button", { name: "Reintentar", exact: true }).click();
  await expect(cell).toHaveValue("absent");
  await cell.selectOption("present");
  await expect(cell).toHaveValue("present");
  await context.setOffline(true);
  await cell.selectOption("absent");
  await expect(
    page.getByRole("button", { name: "Reintentar", exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Reintentar", exact: true }).click();
  await expect(cell).toHaveValue("absent");
  // A second client changes the same cell; the browser must not overwrite silently.
  const data = await (await request.get(`/api/books/${book}`)).json();
  const a = data.attendance.find(
    (a: any) => a.enrollment_id === enrollment && a.date === "2026-03-02",
  );
  expect(
    (
      await request.post(`/api/books/${book}/attendance`, {
        headers: { Origin: origin },
        data: {
          enrollment_id: enrollment,
          date: "2026-03-02",
          slot: 0,
          status: "present",
          expected_revision: a.revision,
        },
      })
    ).ok(),
  ).toBeTruthy();
  await cell.selectOption("justified");
  await expect(
    page.getByRole("button", { name: "Reemplazar por mi cambio", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reemplazar por mi cambio", exact: true })
    .click();
  await expect(cell).toHaveValue("justified");
  // Reauthentication preserves the pending write.
  await context.clearCookies();
  await cell.selectOption("present");
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(cell).toHaveValue("present");
  await request.post("/api/login", {
    headers: { Origin: origin },
    data: { kind: "admin", password: process.env.CAC_ADMIN_PASSWORD },
  });
  expect(
    (
      await request.post("/api/admin", {
        headers: { Origin: origin },
        data: { action: "archive", entity: "book", id: book, archived: true },
      })
    ).ok(),
  ).toBeTruthy();
  await request.post("/api/login", {
    headers: { Origin: origin },
    data: { kind: "book", book_id: book, password: "browser-test-password" },
  });
  await page.reload();
  await expect(page.getByText(/Libro archivado · Solo consulta/)).toBeVisible();
  await expect(cell).toBeDisabled();
  expect(
    (
      await request.get(
        `/api/books/${book}/export?from=2026-03-01&to=2026-03-31`,
      )
    ).ok(),
  ).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Estudiantes", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Estudiantes del libro" }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/piloto-mobile.png",
    fullPage: true,
  });
});

test("edición, archivo y restauración desde administración; protección al volver atrás", async ({
  page,
}) => {
  // Establish this scenario's own state so it also works when selected alone.
  await transaction(async (c) => {
    await c.query("UPDATE books SET archived_at=now() WHERE id=$1", [book]);
    await c.query(
      "UPDATE enrollments SET note='Le gusta la música rock',note_revision=note_revision+1 WHERE id=$1",
      [enrollment],
    );
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Administración", exact: true })
    .click();
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill(process.env.CAC_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Editar y archivar", exact: true })
    .click();
  const original = `Piloto ${book.slice(0, 8)}`;
  const originalRow = page.getByRole("row").filter({ hasText: original });
  // Restore the archived fixture before editing.
  page.once("dialog", (dialog) => dialog.accept());
  await originalRow
    .getByRole("button", { name: "Restaurar", exact: true })
    .click();
  await expect(
    originalRow.getByRole("button", { name: "Editar", exact: true }),
  ).toBeEnabled();
  await originalRow
    .getByRole("button", { name: "Editar", exact: true })
    .click();
  const renamed = `Piloto editado ${book.slice(0, 8)}`;
  await page.getByLabel("Disciplina", { exact: true }).fill(renamed);
  await page
    .getByRole("button", { name: "Guardar cambios", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: renamed });
  await expect(row).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Restaurar", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Restaurar", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Editar", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Volver a los libros", exact: true })
    .click();
  await page
    .getByRole("button", { name: new RegExp("CAC LIBRO DE CLASES " + renamed) })
    .click();
  await page.getByRole("tab", { name: "Estudiantes", exact: true }).click();
  await page.getByRole("button", { name: "Nota", exact: true }).first().click();
  await page
    .getByLabel("Nota breve", { exact: true })
    .fill("Borrador que debe conservarse");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page.getByLabel("Nota breve", { exact: true })).toHaveValue(
    "Borrador que debe conservarse",
  );
  await expect(page).toHaveURL(new RegExp("#book/" + book));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
