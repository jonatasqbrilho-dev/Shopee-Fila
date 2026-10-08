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
// Os modelos mudam com o tempo, então o código descobre um modelo ativo pela própria API.
// Para fixar um modelo, defina GROQ_MODEL ou GEMINI_MODEL no Netlify.
const lerJson = (t) => JSON.parse(t.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/)[0]);
let pGroq, pGemini;

const modeloGroq = () => (pGroq ??= (async () => {
  if (process.env.GROQ_MODEL) return process.env.GROQ_MODEL;
  const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } });
  const j = await r.json();
  if (!j.data) throw new Error("Groq modelos: " + JSON.stringify(j).slice(0, 200));
  const ids = j.data.map((m) => m.id).filter((id) => !/whisper|tts|guard|embed|compound|orpheus/i.test(id));
  const pref = [/llama-3\.3-70b/, /gpt-oss-120b/, /llama-4|maverick|scout/, /gpt-oss-20b/, /llama/];
  const m = pref.map((re) => ids.find((id) => re.test(id))).find(Boolean) || ids[0];
  console.log("Groq usando modelo:", m);
  return m;
})());

async function groq(prompt) {
  try {
    const model = await modeloGroq();
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    if (!j.choices) throw new Error("Groq: " + JSON.stringify(j).slice(0, 200));
    return lerJson(j.choices[0].message.content);
  } catch (e) { pGroq = undefined; throw e; }
}

const modeloGemini = () => (pGemini ??= (async () => {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${process.env.GEMINI_API_KEY}`);
  const j = await r.json();
  if (!j.models) throw new Error("Gemini modelos: " + JSON.stringify(j).slice(0, 200));
  const nomes = j.models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace("models/", ""));
  const flash = nomes.filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort((a, b) => parseFloat(b.split("-")[1]) - parseFloat(a.split("-")[1]));
  const m = flash[0] || nomes.find((n) => /flash/.test(n) && !/image|tts|live|embed/.test(n)) || nomes[0];
  console.log("Gemini usando modelo:", m);
  return m;
})());

async function gemini(prompt) {
  try {
    const model = await modeloGemini();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
    });
    const j = await r.json();
    if (!j.candidates) throw new Error("Gemini: " + JSON.stringify(j).slice(0, 200));
    return lerJson(j.candidates[0].content.parts[0].text);
  } catch (e) { pGemini = undefined; throw e; }
}
async function avaliar(p) {
  const prompt = `Você avalia produtos da Shopee Brasil para divulgação como afiliado em vídeos curtos. Responda SÓ JSON: {"nota": inteiro 0-100, "motivo": "uma frase", "legenda": "legenda curta de venda com emojis, sem preço e sem aviso de preço sujeito a alteração"}. Critérios: procura (vendas), compra por impulso, faixa de preço, desconto, avaliação, comissão e se o produto rende bom vídeo.\nProduto: ${JSON.stringify(p)}`;
  for (const chamar of [groq, gemini]) {
    try { const r = await chamar(prompt); const nota = Math.round(Number(r.nota)); if (Number.isFinite(nota)) return { ...r, nota: Math.min(100, Math.max(0, nota)) }; console.error("IA sem nota válida:", JSON.stringify(r).slice(0, 200)); } catch (e) { console.error("IA falhou:", e.message); }
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
        } catch (e) { console.error("avaliar:", e.message); return null; }
      }))).filter(Boolean);
      if (linhas.length) await sb.from("produtos").upsert(linhas, { onConflict: "item_id", ignoreDuplicates: true });
      return linhas.length;
    } catch (e) { console.error(kw, e.message); return 0; }
  }));
  return totais.reduce((a, b) => a + b, 0);
}
