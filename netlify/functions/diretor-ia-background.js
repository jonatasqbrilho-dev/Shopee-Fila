import { db, autorizado, pesquisarEstrategia } from "../lib.js";

export default async (req) => {
  if (!autorizado(req)) return new Response("negado", { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== "string" || typeof body.job_id !== "string") {
    return new Response("Solicitação inválida", { status: 400 });
  }

  const sb = db();
  const { data: produto, error } = await sb.from("produtos")
    .select("*")
    .eq("id", body.id)
    .single();

  if (error || !produto) {
    console.error("Diretor IA: produto não encontrado", error?.message);
    return;
  }
  if (produto.diretor_ia_job_id !== body.job_id || produto.diretor_ia_status !== "queued") {
    console.warn("Diretor IA: tarefa obsoleta ou já iniciada", body.id);
    return;
  }

  const { error: startError } = await sb.from("produtos").update({
    diretor_ia_status: "running",
    diretor_ia_erro: null
  }).eq("id", body.id).eq("diretor_ia_job_id", body.job_id);
  if (startError) {
    console.error("Diretor IA: não foi possível marcar execução", startError.message);
    return;
  }

  try {
    const estrategia = await pesquisarEstrategia(produto);
    const agora = new Date().toISOString();
    const { error: saveError } = await sb.from("produtos").update({
      video_estrategia: estrategia,
      video_pesquisado_em: estrategia.pesquisado_em,
      video_prompt: estrategia.prompt_video,
      diretor_ia_status: "completed",
      diretor_ia_erro: null,
      diretor_ia_concluido_em: agora,
      atualizado_em: agora
    }).eq("id", body.id).eq("diretor_ia_job_id", body.job_id);
    if (saveError) throw new Error("Estratégia gerada, mas não foi possível salvar: " + saveError.message);
  } catch (e) {
    const mensagem = String(e?.message || e || "Falha desconhecida").slice(0, 1500);
    console.error("Diretor IA background:", mensagem);
    await sb.from("produtos").update({
      diretor_ia_status: "error",
      diretor_ia_erro: mensagem,
      diretor_ia_concluido_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    }).eq("id", body.id).eq("diretor_ia_job_id", body.job_id);
  }
};

export const config = { background: true };
