import { test, expect } from "@playwright/test";
for (const width of [390, 1280])
  test(`Maca flotante ${width}px, doble envío e historial`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let calls = 0;
    const payloads: any[] = [];
    let releaseFirst: () => void = () => {};
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = {};
      if (path === "/api/session") body = { kind: "admin", book_id: null };
      if (path === "/api/catalog")
        body = {
          books: [],
          teachers: [],
          periods: [],
          environment: "development",
        };
      if (path === "/api/admin") body = { suspensions: [], pending_count: 0 };
      if (path === "/api/admin/overview") body = { books: [] };
      if (path === "/api/admin/maca") {
        calls++;
        payloads.push(route.request().postDataJSON());
        if (calls === 1) await firstResponse;
        body = {
          kind: "analysis",
          context: {
            metric: "attendance",
            from: "2026-10-01",
            to: "2026-10-30",
          },
          text: "3 sesiones con asistencia registrada.",
          from: "2026-10-01",
          to: "2026-10-30",
          source: "Prueba",
          warning: "Pendiente no significa ausencia.",
          generated_at: "2026-10-30T12:00:00Z",
          usage: { used: 1, limit: 30 },
          rows: [],
          summary: { pending: 2, suspended: 0 },
        };
      }
      await route.fulfill({ json: body });
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Administración", exact: true })
      .click();
    const launcher = page.getByRole("button", { name: "Abrir chat con Maca" });
    await expect(launcher).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Chat con Maca" }),
    ).toBeHidden();
    const launcherBox = await launcher.boundingBox();
    expect(launcherBox!.x).toBeGreaterThan(width / 2);
    await page.screenshot({
      path: `artifacts/maca-collapsed-${width}.png`,
      fullPage: true,
    });
    await launcher.click();
    await expect(
      page.getByRole("heading", { name: "Maca", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Pregunta institucional").fill("Asistencia de hoy");
    await page
      .getByLabel("Pregunta institucional")
      .evaluate((el: HTMLTextAreaElement) => {
        el.form!.requestSubmit();
        el.form!.requestSubmit();
      });
    await expect(page.getByRole("log")).toContainText("Asistencia de hoy");
    await expect(page.getByRole("status")).toContainText(
      "Maca está escribiendo",
    );
    await page.getByLabel("Pregunta institucional").fill("y este semestre?");
    releaseFirst();
    await expect(page.getByRole("log")).toContainText("3 sesiones");
    await expect(page.getByLabel("Pregunta institucional")).toHaveValue(
      "y este semestre?",
    );
    expect(calls).toBe(1);
    await page.getByLabel("Pregunta institucional").press("Enter");
    await expect.poll(() => calls).toBe(2);
    expect(payloads[1].context).toEqual({
      metric: "attendance",
      from: "2026-10-01",
      to: "2026-10-30",
    });
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.getByRole("button", { name: "Minimizar chat de Maca" }).click();
    await expect(launcher).toBeFocused();
    await page.getByRole("button", { name: "Profesores", exact: true }).click();
    await launcher.click();
    await expect(page.getByRole("log")).toContainText("3 sesiones");
    await page.getByRole("button", { name: "Filtros", exact: true }).click();
    await expect(page.getByLabel("Desde", { exact: true })).toBeVisible();
    const box = await page
      .getByRole("region", { name: "Chat con Maca" })
      .boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await page.getByRole("button", { name: "Filtros", exact: true }).click();

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/maca-${width}.png`,
      fullPage: true,
    });
  });
