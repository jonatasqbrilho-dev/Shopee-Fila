import { db, json, autorizado, shopee } from "../lib.js";

async function telegram(p, legenda, video) {
  const caption = `${legenda}\n\n🛒 ${p.link_afiliado}`.slice(0, 1024);
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendVideo`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, video, caption }),
  });
  return (await r.json()).ok === true;
}

export default async (req) => {
  const sb = db(), url = new URL(req.url);

  // Página pública "link na bio": sem senha, só dados dos publicados.
  if (req.method === "GET" && url.searchParams.get("publico")) {
    const { data } = await sb.from("produtos").select("nome,imagem,link_afiliado").eq("status", "publicado").order("atualizado_em", { ascending: false }).limit(60);
    return json(data || []);
  }
  if (!autorizado(req)) return json({ erro: "Senha incorreta" }, 401);

  if (req.method === "GET") {
    if (url.searchParams.get("campos")) { // descobre se a API da Shopee tem campo de vídeo
      try {
        const d = await shopee(`{ __type(name: "ProductOfferV2") { fields { name } } }`);
        const campos = d.__type.fields.map((f) => f.name);
        return json({ campos, video: campos.filter((c) => /video|media/i.test(c)) });
      } catch (e) { return json({ erro: e.message }, 500); }
    }
    const { data } = await sb.from("produtos").select("*").eq("status", url.searchParams.get("status") || "pendente").order("nota", { ascending: false }).limit(100);
    return json(data || []);
  }

  const b = await req.json();
  if (b.acao === "upload_url") {
    const path = `${b.id}-${Date.now()}.${String(b.ext || "mp4").replace(/\W/g, "")}`;
    const { data, error } = await sb.storage.from("videos").createSignedUploadUrl(path);
    if (error) return json({ erro: error.message }, 500);
    return json({ url: data.signedUrl, publico: sb.storage.from("videos").getPublicUrl(path).data.publicUrl });
  }

  const upd = { atualizado_em: new Date().toISOString() };
  let aviso = "";
  if (b.acao === "rejeitar") upd.status = "rejeitado";
  else if (b.acao === "sem_video") upd.status = "sem_video";
  else if (b.acao === "publicado") upd.status = "publicado";
  else if (b.acao === "aprovar") {
    Object.assign(upd, { status: "aprovado", legenda: b.legenda, plataformas: b.plataformas || [], video_url: b.video_url });
    if (upd.plataformas.includes("telegram") && b.video_url) {
      const { data: p } = await sb.from("produtos").select("link_afiliado").eq("id", b.id).single();
      upd.telegram_ok = await telegram(p, b.legenda, b.video_url);
      aviso = upd.telegram_ok ? "Enviado ao Telegram." : "Falha ao enviar ao Telegram (vídeo até 20 MB e chaves corretas?).";
      if (upd.telegram_ok && upd.plataformas.every((x) => x === "telegram")) upd.status = "publicado";
    }
  } else return json({ erro: "Ação inválida" }, 400);

  const { error } = await sb.from("produtos").update(upd).eq("id", b.id);
  return error ? json({ erro: error.message }, 500) : json({ ok: true, aviso });
};
