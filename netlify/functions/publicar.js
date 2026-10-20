import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { getStore } from "@netlify/blobs";
import { db, json, autorizado } from "../lib.js";

const TT = "https://open.tiktokapis.com/v2";
const cookie = (name, req) => {
  const raw = req.headers.get("cookie") || "";
  return raw.split(";").map(x => x.trim()).find(x => x.startsWith(name + "="))?.slice(name.length + 1) || "";
};
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const randomState = () => b64(crypto.getRandomValues(new Uint8Array(24)));
const redirect = (url, headers={}) => new Response(null, { status: 302, headers: { Location: url, ...headers } });
const escHtml = s => String(s || "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

async function tiktokOAuthStart(req) {
  const key = process.env.TIKTOK_CLIENT_KEY, redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!key || !redirectUri) return new Response("Configure TIKTOK_CLIENT_KEY e TIKTOK_REDIRECT_URI no Netlify.", { status: 500 });
  const state = randomState();
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.searchParams.set("client_key", key);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "user.info.basic,video.publish");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("disable_auto_auth", "0");
  return redirect(u.toString(), { "Set-Cookie": `tt_oauth_state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
}

async function tiktokOAuthCallback(req) {
  const u = new URL(req.url), code = u.searchParams.get("code"), state = u.searchParams.get("state"), expected = cookie("tt_oauth_state", req);
  if (!state || !expected || state !== expected) return new Response("Estado OAuth inválido. Tente conectar novamente.", { status: 400 });
  if (!code) return new Response("Autorização cancelada ou código ausente.", { status: 400 });
  const form = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY || "", client_secret: process.env.TIKTOK_CLIENT_SECRET || "", code, grant_type: "authorization_code", redirect_uri: process.env.TIKTOK_REDIRECT_URI || "" });
  const r = await fetch(`${TT}/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" }, body: form });
  const j = await r.json();
  if (!r.ok || !j.access_token) return new Response(`Falha no TikTok: ${escHtml(j.error_description || j.error || JSON.stringify(j))}`, { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
  const sb = db();
  const now = new Date();
  const { error } = await sb.from("social_integrations").upsert({ provider: "tiktok", access_token: j.access_token, refresh_token: j.refresh_token, expires_at: new Date(now.getTime() + Number(j.expires_in || 86400) * 1000).toISOString(), open_id: j.open_id || null, scopes: j.scope || null, updated_at: now.toISOString() }, { onConflict: "provider" });
  if (error) return new Response(`Token autorizado, mas não foi possível salvar: ${escHtml(error.message)}`, { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response(`<meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:30px"><h2>✅ TikTok conectado</h2><p>Você pode fechar esta janela e voltar ao Shopee-Fila.</p><script>setTimeout(()=>window.close(),1200)</script></body>`, { headers: { "content-type": "text/html; charset=utf-8", "Set-Cookie": "tt_oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
}

async function getTikTokToken() {
  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  const data = await store.get("main-account", { type: "json" });
  if (!data?.refresh_token) throw new Error("TikTok ainda não está conectado. Clique em Conectar TikTok e autorize a conta.");
  const expiresAt = typeof data.expires_at === "number" ? data.expires_at : new Date(data.expires_at || 0).getTime();
  if (data.access_token && expiresAt > Date.now() + 10 * 60 * 1000) return data.access_token;
  const form = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY || "", client_secret: process.env.TIKTOK_CLIENT_SECRET || "", grant_type: "refresh_token", refresh_token: data.refresh_token });
  const r = await fetch(`${TT}/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" }, body: form });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Não foi possível renovar o TikTok: ${j.error_description || j.error || "erro desconhecido"}`);
  const updated = {
    ...data,
    access_token: j.access_token,
    refresh_token: j.refresh_token || data.refresh_token,
    expires_at: Date.now() + Number(j.expires_in || 86400) * 1000,
    refresh_expires_at: j.refresh_expires_in ? Date.now() + Number(j.refresh_expires_in) * 1000 : data.refresh_expires_at,
    scope: j.scope || data.scope,
    updated_at: new Date().toISOString()
  };
  await store.setJSON("main-account", updated);
  return j.access_token;
}

async function publishTikTok(sb, body) {
  const token = await getTikTokToken();
  const creatorR = await fetch(`${TT}/post/publish/creator_info/query/`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const creator = await creatorR.json();
  if (!creatorR.ok || creator?.error?.code !== "ok") throw new Error(`TikTok creator_info: ${creator?.error?.message || JSON.stringify(creator)}`);
  const options = creator.data?.privacy_level_options || [];
  const privacy = options.includes(body.privacy_level) ? body.privacy_level : options[0];
  if (!privacy) throw new Error("TikTok não retornou opções de privacidade.");
  const videoR = await fetch(body.video_url);
  if (!videoR.ok) throw new Error(`Não foi possível baixar o vídeo (${videoR.status}).`);
  const mime = (videoR.headers.get("content-type") || "video/mp4").split(";")[0];
  const bytes = Buffer.from(await videoR.arrayBuffer());
  if (!bytes.length) throw new Error("Vídeo vazio.");
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Para este envio direto, o vídeo precisa ter até 64 MB.");
  const chunkSize = Math.max(5 * 1024 * 1024, Math.min(64 * 1024 * 1024, bytes.length));
  const total = Math.ceil(bytes.length / chunkSize);
  const initBody = { post_info: { title: String(body.caption || "").slice(0, 2200), privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false, is_aigc: body.is_aigc !== false }, source_info: { source: "FILE_UPLOAD", video_size: bytes.length, chunk_size: chunkSize, total_chunk_count: total } };
  const initR = await fetch(`${TT}/post/publish/video/init/`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(initBody) });
  const init = await initR.json();
  if (!initR.ok || init?.error?.code !== "ok" || !init.data?.upload_url) throw new Error(`TikTok não iniciou o envio: ${init?.error?.message || init?.error?.code || JSON.stringify(init)}`);
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize, end = Math.min(bytes.length, start + chunkSize) - 1, chunk = bytes.subarray(start, end + 1);
    const up = await fetch(init.data.upload_url, { method: "PUT", headers: { "Content-Type": mime, "Content-Length": String(chunk.length), "Content-Range": `bytes ${start}-${end}/${bytes.length}` }, body: chunk });
    if (!up.ok) throw new Error(`TikTok falhou no upload do trecho ${i + 1}/${total}: ${up.status} ${await up.text()}`);
  }
  return { publish_id: init.data.publish_id, privacy_level: privacy, status: "processing" };
}

async function publishTelegram(body) {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0), apiHash = String(process.env.TELEGRAM_API_HASH || ""), session = String(process.env.TELEGRAM_SESSION || "");
  const channel = String(process.env.TELEGRAM_PUBLIC_CHANNEL || "Ofertas24horas2000").replace(/^@/, "");
  if (!apiId || !apiHash || !session) throw new Error("Telegram não configurado no Netlify.");
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 2 });
  await client.connect();
  try {
    if (!(await client.getMe())) throw new Error("Sessão do Telegram inválida ou expirada.");
    const caption = String(body.caption || "") + (body.product_url ? `\n\n🛍️ Comprar: ${body.product_url}` : "");
    const message = await client.sendFile(channel, { file: body.video_url, caption: caption.slice(0, 4096), workers: 2 });
    return { message_id: String(message?.id || ""), channel };
  } finally { try { await client.disconnect(); } catch {} }
}

export default async req => {
  const url = new URL(req.url);
  if (url.searchParams.get("oauth") === "start") return tiktokOAuthStart(req);
  if (url.searchParams.get("oauth") === "callback") return tiktokOAuthCallback(req);
  if (!autorizado(req)) return json({ erro: "Senha incorreta" }, 401);
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);
  try {
    const body = await req.json();
    const sb = db();
    const { data: p, error } = await sb.from("produtos").select("*").eq("id", body.id).single();
    if (error || !p) return json({ erro: error?.message || "Produto não encontrado" }, 404);
    const videoUrl = body.video_url || p.video_url;
    if (!videoUrl) return json({ erro: "Anexe o vídeo antes de publicar." }, 400);
    const caption = body.caption ?? p.legenda ?? "";
    if (body.destino === "telegram") {
      const r = await publishTelegram({ ...body, video_url: videoUrl, caption, product_url: p.link_produto || p.link_afiliado });
      await sb.from("produtos").update({ telegram_published_at: new Date().toISOString(), telegram_message_id: r.message_id, atualizado_em: new Date().toISOString() }).eq("id", p.id);
      return json({ ok: true, destino: "telegram", ...r });
    }
    if (body.destino === "tiktok") {
      const r = await publishTikTok(sb, { ...body, video_url: videoUrl, caption });
      await sb.from("produtos").update({ tiktok_published_at: new Date().toISOString(), tiktok_publish_id: r.publish_id, tiktok_status: r.status, atualizado_em: new Date().toISOString() }).eq("id", p.id);
      return json({ ok: true, destino: "tiktok", ...r });
    }
    return json({ erro: "Destino inválido" }, 400);
  } catch (e) { console.error("publicar:", e); return json({ erro: e?.message || String(e) }, 500); }
};
