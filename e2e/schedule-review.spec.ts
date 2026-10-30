import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`revisa cambio y traslado confirmado (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const book = {
      id: "book",
      teacher_id: "teacher",
      period_id: "period",
      discipline: "Piano",
      sessions_per_week: 1,
      duration_minutes: 45,
    };
    const period = {
      id: "period",
      name: "2026",
      start_date: "2026-03-01",
      end_date: "2026-11-30",
    };
    const data = {
      book,
      period,
      enrollments: [
        {
          id: "student",
          student_id: "person",
          book_id: "book",
          full_name: "Ana Prueba",
          joined_on: "2026-03-01",
          left_on: null,
        },
      ],
      schedules: [
        {
          id: "v1",
          enrollment_id: "student",
          effective_from: "2026-03-01",
          slots: [{ day: 0, time: "15:00" }],
        },
      ],
      attendance: [],
      suspensions: [],
      can_write: true,
    };
    const source = {
      enrollment_id: "student",
      date: "2026-10-19",
      slot: 0,
      time: "15:00",
      status: "present",
      underlying: "present",
      revision: 1,
    };
    const target = {
      enrollment_id: "student",
      date: "2026-10-28",
      slot: 0,
      time: "16:00",
      status: "pending",
      revision: 0,
    };
    let request: any;
    let stale = true;
    let version = 1;
    await page.clock.install({ time: new Date("2026-10-30T15:00:00Z") });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = {};
      if (path.endsWith("/session")) json = { kind: "book", book_id: "book" };
      else if (path.endsWith("/catalog"))
        json = {
          books: [book],
          teachers: [{ id: "teacher", name: "Profesor" }],
          periods: [period],
        };
      else if (path.endsWith("/books/book")) json = data;
      else if (path.endsWith("/requests")) {
        if (route.request().method() === "POST") {
          if (stale) {
            stale = false;
            version = 2;
            await route.fulfill({
              status: 409,
              json: {
                error:
                  "El horario o las asistencias cambiaron. Vuelve a revisar el cambio antes de guardarlo.",
                code: "SCHEDULE_REVIEW_REQUIRED",
              },
            });
            return;
          }
          request = route.request().postDataJSON();
        }
        json = { requests: [] };
      } else if (path.endsWith("/schedule-preview"))
        json = {
          previous: data.schedules[0].slots,
          proposed: [{ day: 2, time: "16:00" }],
          from: "2026-10-14",
          to: period.end_date,
          affected: [source],
          destinations: [target],
          suggestions: [
            {
              from_date: source.date,
              from_slot: 0,
              to_date: target.date,
              to_slot: 0,
            },
          ],
          review_token: `review-${version}`,
        };
      await route.fulfill({ json });
    });
    await page.goto("/#book/book");
    await page.getByRole("tab", { name: "Estudiantes", exact: true }).click();
    await page
      .getByRole("button", { name: "Horario", exact: true })
      .last()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Aplicar desde").fill("2026-10-14");
    await dialog.locator('input[type="time"]').fill("16:00");
    await dialog.locator("select").selectOption("2");
    await dialog
      .getByRole("button", { name: "Revisar cambio", exact: true })
      .click();
    await expect(dialog).toHaveAccessibleName("Revisar horario de Ana Prueba");
    await expect(
      dialog.getByText("Horario anterior", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Ajustar fecha u horario" })
      .click();
    await expect(dialog.getByLabel("Aplicar desde")).toHaveValue("2026-10-14");
    await expect(dialog.locator('input[type="time"]')).toHaveValue("16:00");
    await dialog
      .getByRole("button", { name: "Revisar cambio", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Confirmar y enviar solicitud" })
      .click();
    expect(request).toBeUndefined();
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Confirmar y enviar solicitud" })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("Vuelve a revisar");
    await expect(dialog.getByRole("checkbox")).not.toBeChecked();
    await dialog.getByRole("combobox").selectOption(`${target.date}/0`);
    await dialog.getByRole("checkbox").check();
    await page.screenshot({
      path: `artifacts/schedule-review-${width}.png`,
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Confirmar y enviar solicitud" })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(request).toMatchObject({
      kind: "schedule.update",
      data: {
        effective_from: "2026-10-14",
        slots: [{ day: 2, time: "16:00" }],
        review_token: "review-2",
        transfers: [
          {
            from_date: "2026-10-19",
            from_slot: 0,
            to_date: "2026-10-28",
            to_slot: 0,
          },
        ],
      },
    });
  });
}
