import { z } from "zod";
import { intentSchema, type MacaIntent } from "./maca-provider";
export const conversationContext = z
  .object({
    metric: intentSchema.shape.metric,
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .strict()
  .refine(
    (c) =>
      c.from <= c.to &&
      new Date(c.to).getTime() - new Date(c.from).getTime() <= 366 * 86400000,
    "Período de conversación inválido.",
  );
export type ConversationContext = z.infer<typeof conversationContext>;
export function normalizedQuestion(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
export function smallTalk(question: string): string | null {
  const text = normalizedQuestion(question)
    .replace(/[¡!¿?.,;:]/g, "")
    .trim();
  if (
    (!hasMetric(text) &&
      /^(hola|holi|buenas|buenos dias|buenas tardes|buenas noches|hey)\b/.test(
        text,
      )) ||
    /^(como estas|que tal)( maca)?$/.test(text)
  )
    return "¡Hola! Por aquí, afinada y lista 🎵 ¿Revisamos la asistencia o hay algún pendiente dando vueltas?";
  if (/^(muchas )?gracias( maca)?$/.test(text))
    return "¡De nada! Cuando quieras seguimos con el siguiente compás.";
  if (/^(genial|perfecto|bacan|ok|dale|listo)$/.test(text))
    return "Dale, seguimos cuando quieras. ¿Qué revisamos ahora?";
  if (
    /^(que (haces|puedes hacer)|en que (me )?ayudas|ayuda|quien eres)( maca)?$/.test(
      text,
    )
  )
    return "Soy Maca, tu mano derecha para los números del CAC. Puedo revisar asistencia, estudiantes con más ausencias, libros pendientes, suspensiones y cambios de horario. Por ejemplo: «¿quién faltó más este mes?»; después puedes seguir con «¿y este semestre?». No modifico registros.";
  return null;
}
export function hasMetric(safe: string) {
  return /estudiant|alumn|falt|ausen|inasistencia|asistencia|clase|sesion|registro|profesor|pendiente|suspend|suspension|solicitud|aprobacion|cambio|superpuest|conflict|superpos|evolu|tendencia/.test(
    safe,
  );
}
export function hasPeriod(question: string) {
  return /\b(hoy|ayer|semana|mes|semestre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b|\d{4}-\d{2}-\d{2}/.test(
    normalizedQuestion(question),
  );
}
export function followup(
  question: string,
  safe: string,
  context?: ConversationContext,
) {
  return (
    !!context &&
    !hasMetric(safe) &&
    (hasPeriod(question) ||
      /\b(compara|comparar|comparalo|comparacion|anterior)\b/.test(
        normalizedQuestion(question),
      ))
  );
}
export function providerQuestion(safe: string, context?: ConversationContext) {
  return context ? `${safe} contexto ${context.metric}` : safe;
}
export function inheritIntent(
  intent: MacaIntent,
  context: ConversationContext,
): MacaIntent {
  return { ...intent, metric: context.metric };
}
