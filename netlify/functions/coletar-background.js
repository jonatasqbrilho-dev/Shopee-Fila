import { getStore } from "@netlify/blobs";
import { autorizado } from "../lib.js";
import { coletarCategoria } from "../coleta-feminina.js";

const store = getStore({ name: "coleta-status", consistency: "strong" });

export default async (req) => {
  if (!autorizado(req)) return new Response("negado", { status: 401 });

  let categoria = "feminina";
  try {
    const body = await req.json();
    if (body?.categoria) categoria = String(body.categoria);
  } catch {}

  const categoriasValidas = ["feminina","casa","eletronicos","beleza","acessorios"];
  if (!categoriasValidas.includes(categoria)) categoria = "feminina";

  const inicio = new Date().toISOString();
  await store.setJSON("atual", { status: "running", categoria, inicio, fim: null, adicionados: 0, atualizados: 0, erro: null, detalhes: [] });

  try {
    const resultado = await coletarCategoria(categoria);
    const erro = resultado?.erro || null;
    await store.setJSON("atual", {
      status: erro && !resultado?.total && !resultado?.atualizadosTotal ? "error" : "done",
      categoria,
      inicio,
      fim: new Date().toISOString(),
      adicionados: Number(resultado?.total || 0),
      atualizados: Number(resultado?.atualizadosTotal || 0),
      erro,
      detalhes: resultado?.detalhes || []
    });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    await store.setJSON("atual", { status: "error", categoria, inicio, fim: new Date().toISOString(), adicionados: 0, atualizados: 0, erro: erro.slice(0, 1000), detalhes: [] });
  }
};

export const config = { background: true };
