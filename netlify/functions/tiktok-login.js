import crypto from "node:crypto";
import { autorizado, json } from "../lib.js";

const REDIRECT_URI = "https://shopeefila.netlify.app/tiktok/callback";
const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";

export default async function handler(req) {
  if (!autorizado(req)) return json({ erro: "Acesso não autorizado. Entre novamente no Shopee Fila." }, 401);
  if (req.method !== "GET") return json({ erro: "Use GET para iniciar a conexão." }, 405);

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey || !process.env.TIKTOK_CLIENT_SECRET) {
    return json({ erro: "TikTok não está configurado no Netlify." }, 500);
  }

  const state = crypto.randomBytes(32).toString("hex");
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: "code",
    scope: "user.info.basic,video.publish",
    redirect_uri: REDIRECT_URI,
    state
  });

  return json({ authorization_url: `${AUTH_URL}?${params.toString()}` }, 200, {
    "set-cookie": `tiktok_oauth_state=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
    "cache-control": "no-store"
  });
}
