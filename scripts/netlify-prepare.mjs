import { zipFunctions } from "@netlify/zip-it-and-ship-it";
import { mkdir } from "node:fs/promises";

// Local packaging only: no Netlify authentication, API calls, uploads or deploys.
const output = "artifacts/netlify/functions";
await mkdir(output, { recursive: true });
const functions = await zipFunctions("netlify/functions", output, {
  basePath: process.cwd(),
  config: { "*": { nodeBundler: "esbuild", nodeVersion: "22" } },
  manifest: "artifacts/netlify/functions/manifest.json",
});
if (functions.length !== 1 || functions[0].name !== "api")
  throw new Error("Se esperaba únicamente la función api.");
console.log(
  `Preparación local completa: dist/ y ${output}/api.zip. No se desplegó nada.`,
);
