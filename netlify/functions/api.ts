import type { Context } from "@netlify/functions";
import { handleApi } from "../../server/api";
export default (request: Request, context: Context) =>
  handleApi(request, context.ip || "unknown");
