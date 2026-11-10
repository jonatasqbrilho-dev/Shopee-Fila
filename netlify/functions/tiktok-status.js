import { getStore } from "@netlify/blobs";
import { autorizado } from "../lib.js";

export default async function handler(req) {
  if (!autorizado(req)) return new Response(JSON.stringify({ erro: "Acesso não autorizado." }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (req.method !== "GET") return new Response(JSON.stringify({ erro: "Use GET." }), { status: 405, headers: { "content-type": "application/json" } });

  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  const data = await store.get("main-account", { type: "json" });
  if (!data) return new Response(JSON.stringify({ connected: false }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  return json({
    connected: true,
    open_id: data.open_id || null,
    scope: data.scope || "",
    connected_at: data.connected_at || null,
    expires_at: data.expires_at || null
  }, 200, { "cache-control": "no-store" });
}
