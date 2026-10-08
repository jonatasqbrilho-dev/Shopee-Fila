import { autorizado, coletar } from "../lib.js";
export default async (req) => {
  if (!autorizado(req)) return new Response("negado", { status: 401 });
  await coletar();
};
