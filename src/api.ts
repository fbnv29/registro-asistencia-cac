export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public current?: any,
  ) {
    super(message);
  }
}
let authentication: Promise<void> | null = null;
async function authenticate() {
  if (!authentication)
    authentication = new Promise<void>((resolve, reject) =>
      window.dispatchEvent(
        new CustomEvent("cac-auth-required", { detail: { resolve, reject } }),
      ),
    ).finally(() => {
      authentication = null;
    });
  return authentication;
}
export async function api<T = any>(
  path: string,
  payload?: unknown,
  retry = true,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      method: payload === undefined ? "GET" : "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(30000),
      headers:
        payload === undefined ? {} : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw new ApiError(
      "Sin conexión o tiempo de espera agotado. Conservamos tu cambio en esta pantalla; vuelve a intentarlo.",
      0,
      "NETWORK_ERROR",
    );
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      "El servidor devolvió una respuesta inesperada. Vuelve a intentarlo.",
      response.status,
      "INVALID_RESPONSE",
    );
  }
  if (response.status === 401 && retry && path !== "/login") {
    await authenticate();
    return api<T>(path, payload, false);
  }
  if (!response.ok)
    throw new ApiError(
      data.error || "No se pudo completar la operación.",
      response.status,
      data.code || "INVALID_REQUEST",
      data.current,
    );
  return data;
}

export async function apiBlob(path: string, retry = true): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ApiError(
      "No se pudo descargar. Revisa la conexión y vuelve a intentarlo.",
      0,
      "NETWORK_ERROR",
    );
  }
  if (response.status === 401 && retry) {
    await authenticate();
    return apiBlob(path, false);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error || "No se pudo descargar el archivo.",
      response.status,
      data.code || "INVALID_RESPONSE",
    );
  }
  return response.blob();
}
