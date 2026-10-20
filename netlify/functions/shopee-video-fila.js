import { db, json, autorizado } from "../lib.js";

const statuses = new Set(["pendente", "publicado", "ignorado"]);
const today = () => new Date().toISOString().slice(0, 10);

export default async (req) => {
  if (!autorizado(req)) return json({ erro: "Senha incorreta" }, 401);
  const sb = db();
  const url = new URL(req.url);

  if (req.method === "GET") {
    const date = url.searchParams.get("date") || today();
    const { data, error } = await sb.from("shopee_video_queue").select("*")
      .eq("scheduled_date", date).order("position", { ascending: true }).order("created_at", { ascending: true });
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true, date, items: data || [] });
  }

  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  const body = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  if (body.acao === "adicionar") {
    const name = String(body.product_name || "").trim();
    const date = String(body.scheduled_date || today());
    if (!name) return json({ erro: "Informe o nome do produto." }, 400);
    const { data: countRows, error: countError } = await sb.from("shopee_video_queue").select("id")
      .eq("scheduled_date", date).neq("status", "ignorado");
    if (countError) return json({ erro: countError.message }, 500);
    if ((countRows || []).length >= 10) return json({ erro: "A fila diária já tem 10 vídeos. Escolha outra data ou remova um item." }, 400);
    const item = {
      product_id: body.product_id || null,
      product_name: name.slice(0, 300),
      product_url: String(body.product_url || "").trim() || null,
      video_url: String(body.video_url || "").trim() || null,
      caption: String(body.caption || "").trim().slice(0, 2200),
      scheduled_date: date,
      position: (countRows || []).length + 1,
      status: "pendente",
      updated_at: now
    };
    const { data, error } = await sb.from("shopee_video_queue").insert(item).select("*").single();
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true, item: data });
  }

  if (body.acao === "atualizar") {
    const id = String(body.id || "");
    const patch = { updated_at: now };
    if (typeof body.caption === "string") patch.caption = body.caption.slice(0, 2200);
    if (typeof body.video_url === "string") patch.video_url = body.video_url.trim() || null;
    if (typeof body.product_url === "string") patch.product_url = body.product_url.trim() || null;
    if (typeof body.product_name === "string" && body.product_name.trim()) patch.product_name = body.product_name.trim().slice(0, 300);
    if (Number.isInteger(body.position) && body.position > 0) patch.position = body.position;
    if (body.status && statuses.has(body.status)) {
      patch.status = body.status;
      patch.published_at = body.status === "publicado" ? now : null;
    }
    const { data, error } = await sb.from("shopee_video_queue").update(patch).eq("id", id).select("*").single();
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true, item: data });
  }

  if (body.acao === "excluir") {
    const { error } = await sb.from("shopee_video_queue").delete().eq("id", String(body.id || ""));
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true });
  }

  return json({ erro: "Ação inválida." }, 400);
};
