import { getStore } from "@netlify/blobs";
import { autorizado } from "../lib.js";

export default async function handler(req) {
  if (!autorizado(req)) return new Response(JSON.stringify({ erro: "Acesso não autorizado." }), { status: 401, headers: { "content-type": "application/json" } });
  if (req.method !== "POST") return new Response(JSON.stringify({ erro: "Use POST para desconectar o TikTok." }), { status: 405, headers: { "content-type": "application/json" } });

  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  await store.delete("main-account");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
