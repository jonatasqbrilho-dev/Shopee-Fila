import { getStore } from "@netlify/blobs";
import { autorizado, json } from "../lib.js";

export default async function handler(req) {
  if (!autorizado(req)) return json({ erro: "Acesso não autorizado." }, 401);
  if (req.method !== "POST") return json({ erro: "Use POST para desconectar o TikTok." }, 405);

  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  await store.delete("main-account");
  return json({ ok: true }, 200, { "cache-control": "no-store" });
}
