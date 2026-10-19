import { getStore } from "@netlify/blobs";

export default async function handler() {
  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  const data = await store.get("main-account", { type: "json" });
  if (!data) return new Response(JSON.stringify({ connected: false }), { headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ connected: true, open_id: data.open_id || null, scope: data.scope || "", connected_at: data.connected_at || null, expires_at: data.expires_at || null }), { headers: { "content-type": "application/json" } });
}
