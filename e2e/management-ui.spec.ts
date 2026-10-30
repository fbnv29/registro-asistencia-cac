import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const teacher = {
    id: "teacher",
    name: "Profesora prueba",
    archived_at: null as string | null,
  };
  const period = {
    id: "period",
    name: "2026",
    start_date: "2026-03-01",
    end_date: "2026-11-30",
  };
  const book = {
    id: "book",
    teacher_id: teacher.id,
    period_id: period.id,
    discipline: "Piano",
    teacher_name: teacher.name,
    period_name: period.name,
    sessions_per_week: 1,
    duration_minutes: 45,
  };
  await page.clock.install({ time: new Date("2026-10-30T15:00:00Z") });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path.endsWith("/catalog"))
      data = {
        teachers: [teacher],
        periods: [period],
        books: [book],
        environment: "development",
      };
    else if (path.endsWith("/session")) data = { kind: "admin", book_id: null };
    else if (path.endsWith("/admin/overview")) data = { books: [] };
    else if (path.endsWith("/admin")) {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        if (input.action === "edit-teacher") teacher.name = input.name;
        if (input.action === "archive")
          teacher.archived_at = input.archived ? "2026-10-30" : null;
      }
      data = { suspensions: [], pending_count: 0 };
    } else if (path.endsWith("/books/book"))
      data = {
        book,
        period,
        enrollments: Array.from({ length: 30 }, (_, i) => ({
          id: `e${i}`,
          student_id: `s${i}`,
          book_id: book.id,
          full_name: `Estudiante ${i}`,
          joined_on: period.start_date,
          left_on: null,
        })),
        schedules: Array.from({ length: 30 }, (_, i) => ({
          id: `v${i}`,
          enrollment_id: `e${i}`,
          effective_from: period.start_date,
          slots: [{ day: 0, time: "15:00" }],
        })),
        attendance: [],
        suspensions: [],
        can_write: true,
      };
    await route.fulfill({ json: data });
  });
});

test("edita, archiva y restaura desde Profesores y conserva el foco", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Administración", exact: true })
    .click();
  await page.getByRole("button", { name: "Profesores", exact: true }).click();
  const edit = page.getByRole("button", { name: "Editar", exact: true });
  await edit.click();
  const modal = page.getByRole("dialog");
  await expect(modal).toHaveAccessibleName("Editar profesor");
  await modal.getByLabel("Nombre", { exact: true }).fill("Profesora editada");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(modal).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(
    page.getByRole("row", { name: /Profesora editada/ }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restaurar", exact: true }),
  ).toBeVisible();
  await expect(edit).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restaurar", exact: true }).click();
  await expect(edit).toBeEnabled();
  await page
    .getByRole("button", { name: "Editar y archivar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Editar", exact: true })
    .nth(1)
    .click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Editar período");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const width of [1280, 390])
  test(`asistencia sin scroll vertical interno y regreso a esta semana (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#book/book");
    const scroll = page.locator(".attendance-scroll");
    await expect(scroll).toBeVisible();
    expect(await scroll.evaluate((el) => el.clientHeight)).toBeGreaterThan(900);
    expect(
      await scroll.evaluate((el) => el.scrollHeight <= el.clientHeight),
    ).toBe(true);
    const select = page.getByRole("combobox", { name: "Ir a semana" });
    await select.selectOption({ index: 0 });
    await page
      .getByRole("button", { name: "Ir a esta semana", exact: true })
      .click();
    await expect(select).toHaveValue("2026-10-26");
    await scroll.evaluate((el) => (el.scrollLeft = 0));
    await page
      .getByRole("button", { name: "Ir a esta semana", exact: true })
      .click();
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
  });

test("explica cuando la semana actual queda fuera del período", async ({
  page,
}) => {
  await page.clock.setSystemTime(new Date("2027-01-01T15:00:00Z"));
  await page.goto("/#book/book");
  await expect(
    page.getByRole("button", { name: "Ir a esta semana", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("La semana actual está fuera del período lectivo."),
  ).toBeVisible();
});

test("conserva el formulario y el error si falla guardar", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Administración", exact: true })
    .click();
  await page.getByRole("button", { name: "Profesores", exact: true }).click();
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await page.route("**/api/admin", async (route) => {
    await route.fulfill({
      status: 409,
      json: { error: "No se pudo guardar el profesor." },
    });
  });
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Nombre", { exact: true }).fill("Nombre pendiente");
  await modal.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(modal.getByRole("alert")).toHaveText(
    "No se pudo guardar el profesor.",
  );
  await expect(modal.getByLabel("Nombre", { exact: true })).toHaveValue(
    "Nombre pendiente",
  );
  await modal.getByRole("button", { name: "Cancelar", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    modal.getByRole("button", { name: "Cerrar", exact: true }),
  ).toBeFocused();
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});
