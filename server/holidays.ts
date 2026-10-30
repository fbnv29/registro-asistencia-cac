import Holidays from "date-holidays";
import type { Suspension } from "../src/domain";
const cache = new Map<number, Suspension[]>();
/** National holidays only. School vacations and one-off/local closures remain administrative. */
export function chileHolidays(year: number): Suspension[] {
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new Error("Año de calendario fuera de rango.");
  if (!cache.has(year)) {
    const calendar = new Holidays("CL", { languages: ["es"] });
    // The upstream CL rules omit Holy Saturday and include Easter Sunday instead.
    // Chile's official calendar lists Good Friday and Holy Saturday.
    calendar.setHoliday("easter -1", { name: "Sábado Santo", type: "public" });
    const dates = new Map<string, string[]>();
    for (const holiday of calendar
      .getHolidays(year)
      .filter((h) => h.type === "public" && h.rule !== "easter")) {
      const date = holiday.date.slice(0, 10);
      dates.set(date, [...(dates.get(date) || []), holiday.name]);
    }
    cache.set(
      year,
      [...dates]
        .map(([date, names]) => ({
          id: `holiday:${date}`,
          scope: "center" as const,
          target_id: null,
          start_date: date,
          end_date: date,
          reason: `Feriado · ${names.join(" / ")}`,
          source: "holiday" as const,
          active: true,
        }))
        .sort((a, b) => a.start_date.localeCompare(b.start_date)),
    );
  }
  return cache.get(year)!.map((h) => ({ ...h }));
}
export function holidaysBetween(
  from: string,
  to: string,
  exceptions: Set<string> = new Set(),
): Suspension[] {
  const result: Suspension[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++)
    result.push(...chileHolidays(y));
  return result.filter(
    (h) =>
      h.start_date >= from &&
      h.start_date <= to &&
      !exceptions.has(h.start_date),
  );
}
