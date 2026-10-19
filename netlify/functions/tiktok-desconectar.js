import { getStore } from "@netlify/blobs";

export default async function handler() {
  const store = getStore({ name: "tiktok-auth", consistency: "strong" });
  await store.delete("main-account");
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}
