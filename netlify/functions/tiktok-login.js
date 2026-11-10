import crypto from "node:crypto";
import { autorizado } from "../lib.js";

const REDIRECT_URI = "https://shopeefila.netlify.app/tiktok/callback";
const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";

export default async function handler(req) {
  if (!autorizado(req)) return new Response(JSON.stringify({ erro: "Acesso não autorizado. Entre novamente no Shopee Fila." }), { status: 401, headers: { "content-type": "application/json" } });
  if (req.method !== "GET") return new Response(JSON.stringify({ erro: "Use GET para iniciar a conexão." }), { status: 405, headers: { "content-type": "application/json" } });

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey || !process.env.TIKTOK_CLIENT_SECRET) {
    return new Response(JSON.stringify({ erro: "TikTok não está configurado no Netlify." }), { status: 500, headers: { "content-type": "application/json" } });
  }

  const state = crypto.randomBytes(32).toString("hex");
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: "code",
    scope: "user.info.basic,video.publish",
    redirect_uri: REDIRECT_URI,
    state
  });

  return new Response(JSON.stringify({ authorization_url: `${AUTH_URL}?${params.toString()}` }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `tiktok_oauth_state=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
      "cache-control": "no-store"
    }
  });
}
