import { db, autorizado, pesquisarEstrategia } from "../lib.js";

async function marcarErroSeAtual(sb, id, jobId, mensagem) {
  const agora = new Date().toISOString();
  const { error } = await sb.from("produtos").update({
    diretor_ia_status: "error",
    diretor_ia_erro: String(mensagem || "Falha ao iniciar a tarefa.").slice(0, 1500),
    diretor_ia_concluido_em: agora,
    atualizado_em: agora
  }).eq("id", id).eq("diretor_ia_job_id", jobId).in("diretor_ia_status", ["queued", "running"]);
  if (error) console.error("Diretor IA: não foi possível registrar erro da tarefa", error.message);
}

export default async req => {
  if (!autorizado(req)) return new Response("negado", { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== "string" || typeof body.job_id !== "string") {
    return new Response("Solicitação inválida", { status: 400 });
  }

  let sb;
  try {
    sb = db();
    const { data: produto, error } = await sb.from("produtos")
      .select("*")
      .eq("id", body.id)
      .single();

    if (error || !produto) {
      const mensagem = error?.message || "Produto não encontrado.";
      console.error("Diretor IA: produto não encontrado", mensagem);
      await marcarErroSeAtual(sb, body.id, body.job_id, mensagem);
      return;
    }

    if (produto.diretor_ia_job_id !== body.job_id || produto.diretor_ia_status !== "queued") {
      console.warn("Diretor IA: tarefa obsoleta ou já iniciada", body.id);
      return;
    }

    const { error: startError } = await sb.from("produtos").update({
      diretor_ia_status: "running",
      diretor_ia_erro: null
    }).eq("id", body.id).eq("diretor_ia_job_id", body.job_id).eq("diretor_ia_status", "queued");

    if (startError) {
      console.error("Diretor IA: não foi possível marcar execução", startError.message);
      await marcarErroSeAtual(sb, body.id, body.job_id, startError.message);
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
      await marcarErroSeAtual(sb, body.id, body.job_id, mensagem);
    }
  } catch (e) {
    console.error("Diretor IA background: falha inesperada", e?.message || e);
    if (sb) await marcarErroSeAtual(sb, body.id, body.job_id, e?.message || "Falha inesperada no processamento.");
  }
};

export const config = { background: true };
