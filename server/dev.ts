import "dotenv/config";
import { createServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { handleApi } from "./api";
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa",
});
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/api/")) return vite.middlewares(req, res);
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 256000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : Buffer.concat(chunks),
    });
    const response = await handleApi(
      request,
      req.socket.remoteAddress || "local",
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500).end("No se pudo procesar la solicitud.");
  }
});
server.listen(5173, "127.0.0.1", () =>
  console.log("CAC disponible en http://127.0.0.1:5173"),
);
