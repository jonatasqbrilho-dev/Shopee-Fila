import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { db, json, autorizado } from "../lib.js";

const CHANNEL = String(process.env.TELEGRAM_VIDEO_CHANNEL || "packsdevideosgratis").replace(/^@/, "");
const clean = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const words = s => [...new Set(clean(s).split(" ").filter(x => x.length >= 3))];
const textScore = (product, message) => { const a = words(product), b = new Set(words(message)); if (!a.length) return 0; return Math.min(72, Math.round(a.filter(x => b.has(x)).length / a.length * 72)); };
const messageUrl = id => `https://t.me/${CHANNEL}/${id}`;

async function telegramClient() {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0), apiHash = String(process.env.TELEGRAM_API_HASH || ""), session = String(process.env.TELEGRAM_SESSION || "");
  if (!apiId || !apiHash || !session) throw new Error("Telegram MTProto não configurado. Defina TELEGRAM_API_ID, TELEGRAM_API_HASH e TELEGRAM_SESSION no Netlify.");
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 2 });
  await client.connect();
  if (!(await client.getMe())) throw new Error("Sessão do Telegram inválida ou expirada.");
  return client;
}

async function geminiModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY não configurada.");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`), j = await r.json();
  const models = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
  return models.filter(n => /flash/i.test(n) && !/image|tts|live|embed/i.test(n)).sort().reverse()[0] || models.find(n => /flash/i.test(n)) || models[0];
}

async function imagePart(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`imagem ${r.status}`);
  return { mimeType: r.headers.get("content-type") || "image/jpeg", data: Buffer.from(await r.arrayBuffer()).toString("base64") };
}

async function analyzeImages(product, productImage, thumbUrl, caption) {
  if (!productImage || !thumbUrl || !process.env.GEMINI_API_KEY) return { score: 0, motivo: "Análise visual indisponível." };
  try {
    const [prod, thumb] = await Promise.all([imagePart(productImage), imagePart(thumbUrl)]);
    const model = await geminiModel();
    const prompt = `Você é um verificador visual de vídeos para afiliado Shopee. A primeira imagem é o PRODUTO DO ANÚNCIO. A segunda é o THUMBNAIL DE UM VÍDEO DO TELEGRAM. Produto: ${product}. Mensagem do vídeo: ${caption || "sem legenda"}. Compare visualmente forma, cor, embalagem, marca, conjunto e objeto principal. Não aceite produto apenas parecido. Responda SOMENTE JSON: {"score":0,"motivo":""}. Score 90-100 = mesma peça/produto claramente; 70-89 = forte correspondência; 45-69 = possível/parecido; 0-44 = diferente ou inconclusivo.`;
    const body = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: prod.mimeType, data: prod.data } }, { inlineData: { mimeType: thumb.mimeType, data: thumb.data } }] }], generationConfig: { responseMimeType: "application/json" } };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const data = JSON.parse(text.replace(/```json|```/g, "").trim());
    return { score: Math.max(0, Math.min(100, Math.round(Number(data.score) || 0))), motivo: String(data.motivo || "") };
  } catch (e) { return { score: 0, motivo: `Análise visual falhou: ${e.message}` }; }
}

async function getThumbnail(client, message) { try { const data = message?.media ? await client.downloadMedia(message, { thumb: -1 }) : null; return data ? Buffer.from(data) : null; } catch { return null; } }
async function saveThumb(sb, id, buf) { if (!buf) return null; const path = `telegram-thumbs/${CHANNEL}/${id}.jpg`; const { error } = await sb.storage.from("videos").upload(path, buf, { contentType: "image/jpeg", upsert: true }); if (error) return null; return sb.storage.from("videos").getPublicUrl(path).data.publicUrl; }

async function loadProduct(sb, id, name, link) {
  if (id) { const { data, error } = await sb.from("produtos").select("*").eq("id", id).single(); if (error || !data) throw new Error(error?.message || "Produto não encontrado."); return data; }
  return { nome: name || "", link_produto: link || "", imagem: null };
}

async function searchVideos({ product, maxMessages = 80 }) {
  const sb = db(), client = await telegramClient();
  try {
    const entity = await client.getEntity(CHANNEL);
    const messages = await client.getMessages(entity, { limit: Math.min(Math.max(Number(maxMessages) || 80, 10), 150) });
    const candidates = [];
    for (const m of messages || []) {
      if (!m?.media?.document) continue;
      const attrs = m.media.document.attributes || [];
      const isVideo = attrs.some(a => a.className === "DocumentAttributeVideo") || String(m.media.document.mimeType || "").startsWith("video/");
      if (!isVideo) continue;
      const caption = String(m.message || "");
      candidates.push({ id: Number(m.id), caption, message_url: messageUrl(m.id), base_score: textScore(product.nome, caption), message: m });
    }
    candidates.sort((a, b) => b.base_score - a.base_score);
    const out = [];
    for (const c of candidates.slice(0, 10)) {
      const thumbBuf = await getThumbnail(client, c.message);
      const thumb = await saveThumb(sb, c.id, thumbBuf);
      const visual = product.imagem && thumb ? await analyzeImages(product.nome, product.imagem, thumb, c.caption) : { score: 0, motivo: "Sem imagem de referência/thumbnail para análise visual." };
      const finalScore = visual.score ? Math.round(visual.score * 0.8 + c.base_score * 0.2) : c.base_score;
      const row = { telegram_channel: CHANNEL, telegram_message_id: c.id, telegram_message_url: c.message_url, telegram_caption: c.caption, thumbnail_url: thumb, match_score: finalScore, match_reason: visual.motivo, atualizado_em: new Date().toISOString() };
      const { error } = await sb.from("telegram_video_catalog").upsert(row, { onConflict: "telegram_channel,telegram_message_id" });
      if (!error) out.push({ ...row, id: c.id });
    }
    return out.sort((a, b) => b.match_score - a.match_score).slice(0, 8);
  } finally { try { await client.disconnect(); } catch {} }
}

async function useVideo({ productId, messageId, score }) {
  const sb = db(), client = await telegramClient();
  try {
    const entity = await client.getEntity(CHANNEL), found = await client.getMessages(entity, { ids: [Number(messageId)] }), message = Array.isArray(found) ? found[0] : found;
    if (!message?.media) throw new Error("Vídeo não encontrado no Telegram.");
    const data = await client.downloadMedia(message); if (!data) throw new Error("Não foi possível baixar o vídeo do Telegram.");
    const bytes = Buffer.from(data); if (bytes.length > 49 * 1024 * 1024) throw new Error("Vídeo maior que 49 MB; o armazenamento automático foi bloqueado.");
    const path = `telegram-videos/${CHANNEL}/${messageId}.mp4`;
    const { error: upError } = await sb.storage.from("videos").upload(path, bytes, { contentType: "video/mp4", upsert: true });
    if (upError) throw new Error("Falha ao salvar vídeo: " + upError.message);
    const publicUrl = sb.storage.from("videos").getPublicUrl(path).data.publicUrl, now = new Date().toISOString();
    const { error } = await sb.from("produtos").update({ video_url: publicUrl, video_fonte: "telegram", video_telegram_channel: CHANNEL, video_telegram_message_id: String(messageId), video_match_score: Number(score) || 0, video_match_status: "selecionado", atualizado_em: now }).eq("id", productId);
    if (error) throw new Error("Falha ao associar vídeo ao produto: " + error.message);
    await sb.from("telegram_video_catalog").update({ video_url: publicUrl, selecionado_em: now }).eq("telegram_channel", CHANNEL).eq("telegram_message_id", Number(messageId));
    return { video_url: publicUrl, message_url: messageUrl(messageId), score: Number(score) || 0 };
  } finally { try { await client.disconnect(); } catch {} }
}

export default async req => {
  if (!autorizado(req)) return json({ erro: "Senha incorreta" }, 401);
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);
  try {
    const body = await req.json();
    if (body.acao === "buscar") { const product = await loadProduct(db(), body.produto_id, body.nome, body.link); if (!product.nome) return json({ erro: "Informe o nome do produto." }, 400); return json({ ok: true, canal: CHANNEL, resultados: await searchVideos({ product, maxMessages: body.max_messages }) }); }
    if (body.acao === "usar") { if (!body.produto_id || !body.message_id) return json({ erro: "Produto e vídeo são obrigatórios." }, 400); return json({ ok: true, ...(await useVideo({ productId: body.produto_id, messageId: body.message_id, score: body.score })) }); }
    return json({ erro: "Ação inválida" }, 400);
  } catch (e) { console.error("video-busca:", e); return json({ erro: e?.message || String(e) }, 500); }
};
