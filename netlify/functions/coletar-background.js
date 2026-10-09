import { getStore } from "@netlify/blobs";
import { autorizado, coletar } from "../lib.js";

const store = getStore({ name: "coleta-status", consistency: "strong" });

export default async (req) => {
  if (!autorizado(req)) return new Response("negado", { status: 401 });

  const inicio = new Date().toISOString();
  await store.setJSON("atual", { status: "running", inicio, fim: null, adicionados: 0, erro: null, detalhes: [] });

  try {
    const resultado = await coletar();
    const erro = resultado?.erro || null;
    await store.setJSON("atual", {
      status: erro && !resultado?.total ? "error" : "done",
      inicio,
      fim: new Date().toISOString(),
      adicionados: Number(resultado?.total || 0),
      erro,
      detalhes: resultado?.detalhes || []
    });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    await store.setJSON("atual", { status: "error", inicio, fim: new Date().toISOString(), adicionados: 0, erro: erro.slice(0, 1000), detalhes: [] });
  }
};

export const config = { background: true };
