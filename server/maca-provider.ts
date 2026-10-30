import { z } from "zod";

export const intentSchema = z
  .object({
    metric: z.enum([
      "absences",
      "attendance",
      "teachers",
      "pending",
      "suspended",
      "requests",
      "conflicts",
      "trend",
    ]),
    period: z.enum(["today", "week", "month", "semester"]),
    compare: z.boolean(),
  })
  .strict();
export type MacaIntent = z.infer<typeof intentSchema>;
export type Provider = "groq" | "gemini";
export class ProviderError extends Error {
  constructor(
    public reason:
      "quota" | "payment" | "credentials" | "unavailable" | "invalid_response",
    public status?: number,
  ) {
    super(reason);
  }
}
const instruction =
  "Clasifica vocabulario institucional. Devuelve solo JSON: metric (absences,attendance,teachers,pending,suspended,requests,conflicts,trend), period (today,week,month,semester), compare boolean. Definiciones: absences=estudiantes con más ausencias o faltas registradas; requests=solicitudes o cambios de horario esperando aprobación; pending=libros o registros de asistencia sin completar; conflicts=horarios superpuestos; trend=evolución mensual; teachers=cantidad de profesores con registros; suspended=sesiones suspendidas; attendance=clases registradas o porcentaje de asistencia. Si aparecen aprobación, solicitudes o cambios, usa requests, nunca pending. compare=true solo si se pide comparar períodos. No herramientas ni SQL.";
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    metric: {
      type: "string",
      enum: [
        "absences",
        "attendance",
        "teachers",
        "pending",
        "suspended",
        "requests",
        "conflicts",
        "trend",
      ],
    },
    period: { type: "string", enum: ["today", "week", "month", "semester"] },
    compare: { type: "boolean" },
  },
  required: ["metric", "period", "compare"],
};
const tokens = z.number().int().nonnegative().max(10000000).catch(0);
/** Receives ONLY the institutional vocabulary already filtered by privateQuestion. */
export async function classify(provider: Provider, safe: string) {
  const groq = provider === "groq";
  const url = groq
    ? "https://api.groq.com/openai/v1/chat/completions"
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_MODEL || "gemini-3.5-flash-lite")}:generateContent`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (groq) headers.Authorization = `Bearer ${process.env.GROQ_API_KEY}`;
  else headers["x-goog-api-key"] = process.env.GEMINI_API_KEY!;
  const body = groq
    ? {
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: safe },
        ],
        temperature: 0,
        reasoning_effort: "low",
        max_completion_tokens: 512,
        response_format: {
          type: "json_schema",
          json_schema: { name: "maca_intent", strict: true, schema },
        },
      }
    : {
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: "user", parts: [{ text: safe }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 200,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ProviderError("unavailable");
  }
  if (!response.ok)
    throw new ProviderError(
      response.status === 429
        ? "quota"
        : response.status === 402
          ? "payment"
          : [401, 403].includes(response.status)
            ? "credentials"
            : "unavailable",
      response.status,
    );
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError("invalid_response", response.status);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ProviderError("invalid_response", response.status);
  const usage = {
    input: tokens.parse(
      groq ? data.usage?.prompt_tokens : data.usageMetadata?.promptTokenCount,
    ),
    output: tokens.parse(
      groq
        ? data.usage?.completion_tokens
        : data.usageMetadata?.candidatesTokenCount,
    ),
  };
  // Usage remains available even when a provider returns a malformed or truncated intent.
  const parts = data.candidates?.[0]?.content?.parts;
  const text = groq
    ? data.choices?.[0]?.message?.content
    : Array.isArray(parts)
      ? parts
          .filter((p: any) => p && !p.thought)
          .map((p: any) => (typeof p.text === "string" ? p.text : ""))
          .join("")
      : undefined;
  const parsed = intentSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  );
  return { intent: parsed.success ? parsed.data : null, usage };
}
