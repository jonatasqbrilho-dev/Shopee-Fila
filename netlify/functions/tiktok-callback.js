import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const REDIRECT_URI = "https://shopeefila.netlify.app/tiktok/callback";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

function getCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  const item = raw.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

const go = path => new Response(null, { status: 302, headers: { Location: path } });

export default async function handler(req) {
  const u = new URL(req.url);
  if (u.searchParams.get("error")) return go(`/painel-video.html?tiktok=erro&mensagem=${encodeURIComponent(u.searchParams.get("error_description") || u.searchParams.get("error"))}`);

  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const saved = getCookie(req, "tiktok_oauth_state");
  if (!code || !state || !saved || state.length !== saved.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved))) {
    return go("/painel-video.html?tiktok=erro&mensagem=Autorização%20inválida%20ou%20expirada.");
  }

  const key = process.env.TIKTOK_CLIENT_KEY;
  const secret = process.env.TIKTOK_CLIENT_SECRET;
  if (!key || !secret) return new Response("TikTok não está configurado no Netlify.", { status: 500 });

  const form = new URLSearchParams({ client_key: key, client_secret: secret, code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token || !data.refresh_token) {
    console.error("TikTok OAuth:", data);
    return go(`/painel-video.html?tiktok=erro&mensagem=${encodeURIComponent(data.error_description || data.error || "Não foi possível conectar o TikTok.")}`);
  }

  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  await store.setJSON("main-account", {
    open_id: data.open_id,
    scope: data.scope,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    expires_at: Date.now() + Number(data.expires_in || 86400) * 1000,
    refresh_expires_at: Date.now() + Number(data.refresh_expires_in || 31536000) * 1000,
    connected_at: new Date().toISOString()
  });

  return new Response(null, { status: 302, headers: { Location: "/painel-video.html?tiktok=conectado", "Set-Cookie": "tiktok_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax" } });
}
