export async function api<T = any>(
  path: string,
  payload?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: payload === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      payload === undefined ? {} : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "No se pudo conectar. Vuelve a intentarlo.");
  return data;
}
