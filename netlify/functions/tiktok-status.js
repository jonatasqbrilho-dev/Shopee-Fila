import { getStore } from "@netlify/blobs";
import { autorizado, json } from "../lib.js";

export default async function handler(req) {
  if (!autorizado(req)) return json({ erro: "Acesso não autorizado." }, 401);
  if (req.method !== "GET") return json({ erro: "Use GET." }, 405);

  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  const data = await store.get("main-account", { type: "json" });
  if (!data) return json({ connected: false }, 200, { "cache-control": "no-store" });

  return json({
    connected: true,
    open_id: data.open_id || null,
    scope: data.scope || "",
    connected_at: data.connected_at || null,
    expires_at: data.expires_at || null
  }, 200, { "cache-control": "no-store" });
}
