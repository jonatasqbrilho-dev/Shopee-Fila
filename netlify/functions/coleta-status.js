import { getStore } from "@netlify/blobs";
import { autorizado } from "../lib.js";

const store = getStore({ name: "coleta-status", consistency: "strong" });

export default async (req) => {
  if (!autorizado(req)) return new Response("negado", { status: 401 });
  const status = await store.get("atual", { type: "json" });
  return Response.json(status || {
    status: "idle",
    inicio: null,
    fim: null,
    adicionados: 0,
    erro: null
  });
};
