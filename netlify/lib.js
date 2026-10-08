import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
export const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
export const autorizado = (req) => !!process.env.PAINEL_SENHA && req.headers.get("x-senha") === process.env.PAINEL_SENHA;

// ---------- Shopee (API de afiliados, GraphQL) ----------
export async function shopee(query) {
  const id = process.env.SHOPEE_APP_ID, payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash("sha256").update(id + ts + payload + process.env.SHOPEE_SECRET).digest("hex");
  const r = await fetch("https://open-api.affiliate.shopee.com.br/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `SHA256 Credential=${id}, Timestamp=${ts}, Signature=${sig}` },
    body: payload,
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// ---------- IA: nota de 0 a 100 (Groq, com Gemini de reserva) ----------
async function groq(prompt) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
  });
  return JSON.parse((await r.json()).choices[0].message.content);
}
async function gemini(prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
  });
  return JSON.parse((await r.json()).candidates[0].content.parts[0].text);
}
async function avaliar(p) {
  const prompt = `Você avalia produtos da Shopee Brasil para divulgação como afiliado em vídeos curtos. Responda SÓ JSON: {"nota": inteiro 0-100, "motivo": "uma frase", "legenda": "legenda curta de venda com emojis, sem preço e sem aviso de preço sujeito a alteração"}. Critérios: procura (vendas), compra por impulso, faixa de preço, desconto, avaliação, comissão e se o produto rende bom vídeo.\nProduto: ${JSON.stringify(p)}`;
  for (const chamar of [groq, gemini]) {
    try { const r = await chamar(prompt); if (typeof r.nota === "number") return r; } catch {}
  }
  throw new Error("IA indisponível");
}

// ---------- Coleta ----------
const KW = (process.env.KEYWORDS || "fone bluetooth,organizador de cozinha,luminária led,garrafa térmica,suporte de celular,mini processador").split(",").map((s) => s.trim());
const NOTA_MIN = Number(process.env.NOTA_MIN || 70);
const MIN_VENDAS = Number(process.env.MIN_VENDAS || 100);
const CAMPOS = "itemId productName imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate productLink offerLink shopName";

export async function coletar() {
  const sb = db();
  const kws = [...KW].sort(() => Math.random() - 0.5).slice(0, 3);
  const totais = await Promise.all(kws.map(async (kw) => {
    try {
      const d = await shopee(`{ productOfferV2(keyword: ${JSON.stringify(kw)}, sortType: 2, page: 1, limit: 12) { nodes { ${CAMPOS} } } }`);
      const nodes = d.productOfferV2.nodes.filter((n) => n.sales >= MIN_VENDAS && Number(n.ratingStar) >= 4.5);
      const { data: ja } = await sb.from("produtos").select("item_id").in("item_id", nodes.map((n) => String(n.itemId)));
      const vistos = new Set((ja || []).map((x) => x.item_id));
      const novos = nodes.filter((n) => !vistos.has(String(n.itemId))).slice(0, 4);
      const linhas = (await Promise.all(novos.map(async (n) => {
        try {
          const a = await avaliar(n);
          return {
            item_id: String(n.itemId), nome: n.productName, imagem: n.imageUrl, preco: Number(n.priceMin),
            desconto: Number(n.priceDiscountRate) || 0, vendas: n.sales, avaliacao: Number(n.ratingStar),
            comissao: Number(n.commissionRate), link_afiliado: n.offerLink, link_produto: n.productLink,
            nota: a.nota, motivo: a.motivo, legenda: a.legenda,
            status: a.nota >= NOTA_MIN ? "pendente" : "descartado",
          };
        } catch { return null; }
      }))).filter(Boolean);
      if (linhas.length) await sb.from("produtos").upsert(linhas, { onConflict: "item_id", ignoreDuplicates: true });
      return linhas.length;
    } catch (e) { console.error(kw, e.message); return 0; }
  }));
  return totais.reduce((a, b) => a + b, 0);
}
