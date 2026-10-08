import { getStore } from "@netlify/blobs";
import { autorizado, coletar } from "../lib.js";

const store = getStore({ name: "coleta-status", consistency: "strong" });

export default async (req) => {
  if (!autorizado(req)) return new Response("negado", { status: 401 });

  const inicio = new Date().toISOString();
  await store.setJSON("atual", {
    status: "running",
    inicio,
    fim: null,
    adicionados: 0,
    erro: null
  });

  try {
    const resultado = await coletar();
    await store.setJSON("atual", {
      status: "done",
      inicio,
      fim: new Date().toISOString(),
      adicionados: Number(resultado?.total || 0),
      erro: null
    });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    await store.setJSON("atual", {
      status: "error",
      inicio,
      fim: new Date().toISOString(),
      adicionados: 0,
      erro: erro.slice(0, 1000)
    });
  }
};

export const config = { background: true };
