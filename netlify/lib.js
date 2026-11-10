import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
export const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
export const autorizado = (req) => !!process.env.PAINEL_SENHA && req.headers.get("x-senha") === process.env.PAINEL_SENHA;

export async function shopee(query) {
  const id = process.env.SHOPEE_APP_ID, payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash("sha256").update(id + ts + payload + process.env.SHOPEE_SECRET).digest("hex");
  const r = await fetch("https://open-api.affiliate.shopee.com.br/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `SHA256 Credential=${id}, Timestamp=${ts}, Signature=${sig}` }, body: payload });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors)); return j.data;
}

const lerJson = (texto) => {
  const limpo = String(texto || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/i, "")
    .trim();
  try { return JSON.parse(limpo); } catch {}
  let inicio = -1, profundidade = 0, emString = false, escape = false;
  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i];
    if (emString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') { emString = true; continue; }
    if (c === "{") { if (profundidade === 0) inicio = i; profundidade++; }
    if (c === "}") {
      profundidade--;
      if (profundidade === 0 && inicio >= 0) {
        try { return JSON.parse(limpo.slice(inicio, i + 1)); } catch {}
        inicio = -1;
      }
    }
  }
  throw new Error("A IA retornou JSON incompleto ou inválido. Tente novamente.");
};
let pGroq, pGemini;
// Prefere modelo menor e evita uma chamada extra à API de listagem de modelos.
const modeloGroq = () => (pGroq ??= Promise.resolve(process.env.GROQ_MODEL || "openai/gpt-oss-20b"));
async function groq(prompt, options = {}) {
  try {
    const model = await modeloGroq();
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({model,messages:[{role:"user",content:prompt}],max_completion_tokens:options.maxTokens || 1400,...(options.reasoningEffort?{reasoning_effort:options.reasoningEffort}:{}),response_format:{type:"json_object"}}),
      signal:options.signal || AbortSignal.timeout(options.timeoutMs || 2500)
    });
    const j=await r.json();
    if(!r.ok || !j.choices?.[0]?.message?.content) throw new Error("Groq HTTP "+r.status+": "+JSON.stringify(j).slice(0,300));
    if (j.choices[0].finish_reason === "length") throw new Error("Groq cortou a resposta por limite de tokens.");
    return lerJson(j.choices[0].message.content);
  } catch(e){pGroq=undefined;throw e;}
}
// Usa um modelo Flash estável sem consultar a lista de modelos a cada execução.
const modeloGemini = () => Promise.resolve(process.env.GEMINI_MODEL || "gemini-2.5-flash");
// Modelo exclusivo do Diretor IA; mantém o provedor do fluxo legado inalterado.
const modeloGeminiDiretor = () => Promise.resolve("gemini-3.8-flash");
async function gemini(prompt, options = {}) {
  try {
    const model=await modeloGemini();
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:options.maxTokens || 1400,...(options.thinkingBudget !== undefined?{thinkingConfig:{thinkingBudget:options.thinkingBudget}}:{})}}),
      signal:options.signal || AbortSignal.timeout(options.timeoutMs || 2500)
    });
    const j=await r.json();
    if(!r.ok || !j.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Gemini HTTP "+r.status+": "+JSON.stringify(j).slice(0,300));
    if (j.candidates[0].finishReason === "MAX_TOKENS") throw new Error("Gemini cortou a resposta por limite de tokens.");
    return lerJson(j.candidates[0].content.parts[0].text);
  } catch(e){pGemini=undefined;throw e;}
}
// Chamada Gemini exclusiva do Diretor IA, isolada do fluxo legado.
async function geminiDiretor(prompt, options = {}) {
  const model = await modeloGeminiDiretor();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: options.maxTokens || 4096, ...(options.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } } : {}) } }),
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 20000)
  });
  const j = await r.json();
  const texto = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("\n");
  if (!r.ok || !texto) throw new Error("Gemini Diretor HTTP " + r.status + ": " + JSON.stringify(j).slice(0, 450));
  if (j.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error("Gemini Diretor cortou a resposta por limite de tokens.");
  return lerJson(texto);
}

async function iaJson(prompt){
  const erros=[];
  for(const [nome,chamar] of [["Groq",groq],["Gemini",gemini]]){
    try{return await chamar(prompt)}catch(e){erros.push(nome+": "+e.message);console.error("IA:",nome,e.message)}
  }
  throw new Error("Os serviços de IA não responderam. "+erros.join(" | "));
}

// O Diretor IA produz uma estratégia extensa: usa os dois provedores em paralelo,
// com mais tempo e tokens, e encerra a chamada perdedora assim que uma resposta válida chega.
async function iaJsonDiretor(prompt) {
  const controladores = [new AbortController(), new AbortController()];
  const limite = setTimeout(() => controladores.forEach(c => c.abort()), 20000);
  const validar = async (chamar) => {
    const resposta = await chamar();
    if (!resposta?.formato_escolhido || !resposta?.prompt_video || !Array.isArray(resposta?.clipes) || !resposta.clipes.length) {
      throw new Error("O provedor retornou uma estratégia incompleta ou sem clipes.");
    }
    if (resposta.clipes.length > 4) resposta.clipes = resposta.clipes.slice(0, 4);
    // Se o provedor devolver somente um clipe, desdobra a ideia em três partes
    // sem acrescentar características ao produto: gancho, demonstração e CTA.
    if (resposta.clipes.length === 1) {
      const base = resposta.clipes[0];
      const orientacoes = [
        { objetivo: "Gancho visual imediato", direcao: "PARTE 1 DE 3 — ABERTURA: comece com o produto claramente visível e uma ação visual simples que desperte curiosidade. Apresente o gancho nos primeiros instantes. Não antecipe a conclusão nem invente atributos." },
        { objetivo: "Demonstração do produto", direcao: "PARTE 2 DE 3 — DEMONSTRAÇÃO: mantenha exatamente o mesmo produto, pessoa e cenário. Mostre apenas a característica ou uso que esteja confirmado nos dados e na imagem. Não repita a abertura e não invente funções." },
        { objetivo: "Fechamento e chamada para ação", direcao: "PARTE 3 DE 3 — FECHAMENTO: mantenha a continuidade visual. Finalize mostrando o produto com clareza e inclua uma chamada natural para conferir o item no link. Não acrescente alegações novas." }
      ];
      resposta.clipes = orientacoes.map((o, i) => ({
        ...base,
        numero: i + 1,
        objetivo: o.objetivo,
        acao: (base.acao ? String(base.acao) + " " : "") + o.direcao,
        fala: i === 2 ? "Confira os detalhes deste produto no link." : (i === 0 ? String(resposta.gancho || base.fala || "") : String(base.fala || "")),
        prompt_flow: String(base.prompt_flow || "") + "\\n\\n" + o.direcao
      }));
    }
    if (resposta.clipes.length < 2) {
      throw new Error("Não foi possível estruturar os clipes da estratégia.");
    }
    // Corrige durações inconsistentes antes de aceitar a estratégia.
    // Cada clipe fica entre 4 e 10 s; o total fica entre 16 e 30 s.
    const duracoes = resposta.clipes.map(c => {
      const n = Math.round(Number(c.duracao_segundos));
      return Number.isFinite(n) ? Math.max(4, Math.min(10, n)) : 6;
    });
    const minimoTotal = 16, maximoTotal = Math.min(30, duracoes.length * 10);
    let total = Math.max(minimoTotal, Math.min(maximoTotal, duracoes.reduce((a, n) => a + n, 0)));
    let diferenca = total - duracoes.reduce((a, n) => a + n, 0);
    for (let i = 0; i < duracoes.length && diferenca !== 0; i++) {
      const ajuste = diferenca > 0 ? Math.min(10 - duracoes[i], diferenca) : -Math.min(duracoes[i] - 4, -diferenca);
      duracoes[i] += ajuste;
      diferenca -= ajuste;
    }
    total = duracoes.reduce((a, n) => a + n, 0);
    resposta.clipes = resposta.clipes.map((c, i) => ({
      ...c,
      numero: i + 1,
      duracao_segundos: duracoes[i],
      prompt_flow: ("DURAÇÃO EXATA DESTE CLIPE: " + duracoes[i] + " segundos. Gere somente esta cena, sem prolongar nem encurtar.\\n" +
        String(c.prompt_flow || "").trim().replace(/(?:dura[cç][aã]o|duration)\\s*:?\\s*\\d+\\s*(?:s|segundos?)?/gi, "").trim())
    }));
    resposta.duracao_segundos = total;
    return resposta;
  };
  try {
    return await Promise.any([
      validar(() => groq(prompt, { signal: controladores[0].signal, maxTokens: 4096, reasoningEffort: "low" })),
      validar(() => geminiDiretor(prompt, { signal: controladores[1].signal, maxTokens: 4096, thinkingBudget: 0 }))
    ]);
  } catch (e) {
    const motivos = (e.errors || [e]).map(x => x?.message || String(x));
    throw new Error("O Diretor IA não conseguiu concluir a estratégia. " + motivos.join(" | "));
  } finally {
    clearTimeout(limite);
    controladores.forEach(c => c.abort());
  }
}

const limitarLegenda=texto=>{let s=String(texto||"").replace(/\s+/g," ").trim();if(s.length<=150)return s;return s.slice(0,150).replace(/\s+\S*$/," ").trim();};
const limparLegendaVendas=texto=>String(texto||"").replace(/\b(?:\d+[.,]?\d*)\s*(?:mil|milhares|k)?\s*(?:unidades?|produtos?|vendas?|compradores?|clientes?)\b/gi,"").replace(/\b(?:mais vendido|mais vendidos|campe[aã]o de vendas|recorde de vendas|viral|sucesso de vendas|top vendas|ranking|ranking de vendas)\b/gi,"").replace(/\s{2,}/g," ").replace(/\s+([,.!?])/g,"$1").trim();

export async function avaliar(p) {
  const prompt=`Você avalia produtos da Shopee Brasil para divulgação como afiliado. Responda SOMENTE um JSON válido com os campos: {"nota": inteiro de 0 a 100, "motivo": "justificativa curta da nota", "legenda": "legenda pronta para publicar"}.

A legenda deve fazer a pessoa entender rapidamente O PRODUTO. O público quer saber o que é, para que serve, como é usado, suas principais características e benefícios reais. NÃO transforme a legenda em propaganda de popularidade.

NÃO fale sobre quantidade de vendas, número de compradores, ranking, "mais vendido", "10 mil vendidos", "20 mil vendidos", tendência de vendas, sucesso de vendas ou qualquer métrica comercial. Esses dados podem ser usados internamente para selecionar produtos, mas NUNCA devem aparecer na legenda.

Crie uma legenda curta e natural: apresente o produto, destaque somente benefícios/usos comprovados pelo nome e pelos dados do produto e termine com uma chamada natural para conferir o produto no link. Use palavras-chave relevantes que uma pessoa realmente pesquisaria para encontrar esse produto. NÃO invente funções, materiais, qualidade, resultados, medidas, compatibilidade, certificações, marca, variação, desconto ou qualquer característica que não esteja comprovada. A legenda deve deixar claro qual é o produto e não pode promover outro item, acessório ou produto semelhante.

REGRA DE RELEVÂNCIA SHOPEE: o conteúdo deve corresponder exatamente ao produto vinculado. Não trate produto parecido como se fosse o mesmo. Respeite marca, modelo, cor, tamanho, capacidade, voltagem, fragrância, sabor, material, acabamento, quantidade e composição quando essas informações estiverem disponíveis. Se for kit, deixe a quantidade/composição clara somente quando constar nos dados.

NÃO inclua preço, valor em reais, porcentagem de desconto ou promessa de promoção. Use hashtags específicas e relevantes para o produto e suas características reais. Priorize hashtags que também funcionem como palavras-chave de busca. Use no máximo 3 hashtags quando houver pouco espaço. Escreva em português brasileiro, com texto natural e sem exageros.

LIMITE OBRIGATÓRIO: a legenda completa, incluindo espaços, emojis, pontuação e hashtags, deve ter NO MÁXIMO 150 CARACTERES. Conte os caracteres antes de responder. Se ultrapassar 150, encurte até ficar com 150 ou menos. Não entregue texto acima desse limite.

Produto: ${JSON.stringify(p)}`;
  const r=await iaJson(prompt); const nota=Math.round(Number(r.nota)); if(!Number.isFinite(nota)) throw new Error("IA sem nota válida");
  const legenda=limitarLegenda(limparLegendaVendas(r.legenda));
  if(!legenda) throw new Error("IA sem legenda válida");
  return {...r,nota:Math.min(100,Math.max(0,nota)),legenda};
}

const limitarPrompt=texto=>{let s=String(texto||"");if(s.length<=850)return s;return s.slice(0,850).replace(/\s+\S*$/," ").trim();};
const removerPreco=texto=>String(texto||"").replace(/R\$\s?\d+(?:[.,]\d{2})?/gi,"").replace(/\b\d+[.,]\d{2}\s?(?:reais)?\b/gi,"").replace(/\b(?:por|de|a partir de)\s+\d+(?:[.,]\d{2})?\s?(?:reais|R\$)?\b/gi,"").replace(/\s{2,}/g," ").trim();
const removerMetricasVendas=texto=>String(texto||"").replace(/\b(?:\d+[.,]?\d*)\s*(?:mil|milhares|k)?\s*(?:unidades?|produtos?|vendas?|compradores?|clientes?)\b/gi,"").replace(/\b(?:mais vendido|mais vendidos|campe[aã]o de vendas|recorde de vendas|viral|sucesso de vendas|top vendas|ranking|ranking de vendas)\b/gi,"").replace(/\s{2,}/g," ").trim();

export async function gerarConteudo(p) {
  const prompt=`Você é especialista em conteúdo para afiliados da Shopee Brasil. Crie um prompt curto e fiel para vídeo vertical 9:16 de 20 a 30 segundos, usando as imagens reais do anúncio como referência principal.

O vídeo deve explicar visualmente o que é o produto, como é usado e quais características comprovadas merecem destaque. O produto deve ser o protagonista. Preserve exatamente modelo, cor, formato, marca, quantidade, embalagem e acessórios confirmados. Não invente materiais, funções, medidas, compatibilidades, resultados ou benefícios. Se faltarem detalhes, apresente visualmente o item sem afirmar o que não está confirmado. Não mencione preço, desconto, vendas, ranking ou popularidade. Não crie roteiro por segundos, storyboard ou falas; deixe a ferramenta de vídeo decidir a montagem. Use português brasileiro e linguagem natural.

Retorne SOMENTE JSON válido com este formato:
{"video_prompt":"prompt de até 850 caracteres","nota":75,"motivo":"avaliação criativa curta","legenda":"legenda para publicar com até 150 caracteres, incluindo hashtags e CTA"}

A nota mede adequação criativa, não prevê visualizações ou vendas. A legenda deve identificar o produto e usar somente informações comprovadas. Não ultrapasse os limites de caracteres.

Dados do produto: ${JSON.stringify({nome:p.nome,descricao:p.descricao,marca:p.marca,modelo:p.modelo,cor:p.cor,quantidade:p.quantidade,imagem:p.imagem,link_produto:p.link_produto})}`;
  const r=await iaJson(prompt);
  const texto=typeof r === "string" ? r : (r.video_prompt || r.prompt || "");
  const video_prompt=limitarPrompt(removerMetricasVendas(removerPreco(texto)));
  if(!video_prompt) throw new Error("A IA não retornou um prompt válido. Tente novamente.");
  const notaBruta=Math.round(Number(r.nota));
  const nota=Number.isFinite(notaBruta)?Math.min(100,Math.max(0,notaBruta)):70;
  const motivo=String(r.motivo||"Adequação criativa estimada com base nos dados disponíveis do produto.").slice(0,500);
  const legenda=limitarLegenda(limparLegendaVendas(r.legenda));
  if(!legenda) throw new Error("A IA não retornou uma legenda válida. Tente novamente.");
  return {video_prompt,nota,motivo,legenda};
}

const KW=(process.env.KEYWORDS||"fone bluetooth,organizador de cozinha,luminária led,garrafa térmica,suporte de celular,mini processador").split(",").map(s=>s.trim());
const NOTA_MIN=Number(process.env.NOTA_MIN||70),MIN_VENDAS=Number(process.env.MIN_VENDAS||100);
const CAMPOS="itemId productName imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate productLink offerLink shopName";
export async function coletar(){
  const sb=db(), kws=[...KW].sort(()=>Math.random()-0.5).slice(0,3);
  const detalhes=[];
  for (const kw of kws) {
    const item={palavra_chave:kw, encontrados:0, elegiveis:0, novos:0, atualizados:0, avaliados:0, gravados:0, erro:null};
    try {
      const d=await shopee(`{ productOfferV2(keyword: ${JSON.stringify(kw)}, sortType: 2, page: 1, limit: 12) { nodes { ${CAMPOS} } } }`);
      const nodes=d?.productOfferV2?.nodes||[];
      item.encontrados=nodes.length;
      const elegiveis=nodes.filter(n=>Number(n.sales)>=MIN_VENDAS&&Number(n.ratingStar)>=4.5);
      item.elegiveis=elegiveis.length;
      if (!elegiveis.length) { detalhes.push(item); continue; }
      const ids=elegiveis.map(n=>String(n.itemId));
      const {data:ja,error:erroBusca}=await sb.from("produtos").select("item_id").in("item_id",ids);
      if(erroBusca) throw new Error("Supabase consulta: "+erroBusca.message);
      const vistos=new Set((ja||[]).map(x=>String(x.item_id)));
      const existentes=elegiveis.filter(n=>vistos.has(String(n.itemId)));
      const novos=elegiveis.filter(n=>!vistos.has(String(n.itemId))).slice(0,4);
      for(const n of existentes){
        const {error}=await sb.from("produtos").update({nome:n.productName,imagem:n.imageUrl,preco:Number(n.priceMin),desconto:Number(n.priceDiscountRate)||0,vendas:n.sales,avaliacao:Number(n.ratingStar),comissao:Number(n.commissionRate),link_afiliado:n.offerLink,link_produto:n.productLink,atualizado_em:new Date().toISOString()}).eq("item_id",String(n.itemId));
        if(error){item.erro=item.erro||("Falha ao atualizar item "+n.itemId+": "+error.message);console.error("Atualizar produto:",kw,n.itemId,error.message);}else{item.atualizados++;item.gravados++;}
      }
      item.novos=novos.length;
      const linhas=(await Promise.all(novos.map(async n=>{try{const a=await avaliar(n);item.avaliados++;return {item_id:String(n.itemId),nome:n.productName,imagem:n.imageUrl,preco:Number(n.priceMin),desconto:Number(n.priceDiscountRate)||0,vendas:n.sales,avaliacao:Number(n.ratingStar),comissao:Number(n.commissionRate),link_afiliado:n.offerLink,link_produto:n.productLink,nota:a.nota,motivo:a.motivo,legenda:a.legenda,status:a.nota>=NOTA_MIN?"pendente":"descartado",atualizado_em:new Date().toISOString()};}catch(e){console.error("avaliar:",kw,e.message);item.erro=item.erro||("Falha na IA: "+e.message);return null;}}))).filter(Boolean);
      if(linhas.length){const {error:erroGravar}=await sb.from("produtos").insert(linhas);if(erroGravar)throw new Error("Supabase gravação: "+erroGravar.message);item.gravados+=linhas.length;}
    } catch(e) {item.erro=item.erro||(e instanceof Error?e.message:String(e));console.error("Coleta palavra-chave:",kw,item.erro);}
    detalhes.push(item);
  }
  const total=detalhes.reduce((n,x)=>n+x.novos,0),atualizadosTotal=detalhes.reduce((n,x)=>n+x.atualizados,0),erros=detalhes.filter(x=>x.erro);
  return {total,atualizadosTotal,detalhes,erro:total===0&&atualizadosTotal===0&&erros.length?erros.map(x=>x.palavra_chave+": "+x.erro).join(" | "):null};
}

const decodeHtml = (s) => String(s || "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x2F;/g,"/");
const stripTags = (s) => decodeHtml(String(s || "").replace(/<[^>]*>/g," ")).replace(/\\s+/g," ").trim();

async function pesquisarWebProduto(nome, categoria) {
  const consultas = [
    `"${nome}" demonstração avaliação como usar`,
    `${categoria} como apresentar produto vídeo demonstração afiliado`,
    `Shopee Vídeo ${categoria} ideias de apresentação produto`
  ];
  const resultados = await Promise.all(consultas.map(async q => {
    try {
      const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ShopeeFilaResearch/1.0)", "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7" }, signal: AbortSignal.timeout(1200) });
      if (!r.ok) return [];
      const html = await r.text();
      return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
        .filter(m => /result__a/.test(m[1]))
        .map(m => {
          const h = m[1].match(/href=["']([^"']+)["']/i)?.[1] || "";
          let link = decodeHtml(h);
          if (link.startsWith("//")) link = "https:" + link;
          try { const u = new URL(link); const real = u.searchParams.get("uddg"); if (real) link = real; } catch {}
          const title = stripTags(m[2]);
          const after = html.slice((m.index || 0) + m[0].length, (m.index || 0) + m[0].length + 1800);
          const sn = after.match(/result__snippet[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || "";
          return { title, url: link, snippet: stripTags(sn), query: q };
        }).filter(x => x.title && /^https?:\/\//i.test(x.url));
    } catch (e) { console.warn("Pesquisa web:", e.message); return []; }
  }));
  const vistos = new Set();
  return resultados.flat().filter(x => { if (vistos.has(x.url)) return false; vistos.add(x.url); return true; }).slice(0, 12);
}

function categoriaDiretor(nome, cadastrada) {
  const c = String(cadastrada || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const n = String(nome || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const texto = c + " " + n;
  const grupos = [
    ["cozinha", /cozinha|panela|escorredor|talher|frigideira|forma|pote|garrafa|copo|organizador de pia/],
    ["eletronicos", /eletron|fone|bluetooth|carregador|cabo usb|smartwatch|relogio inteligente|mouse|teclado|camera|led|lampada|luminaria/],
    ["beleza", /beleza|maquiagem|cosmet|skincare|cabelo|escova|secador|chapinha|perfume|unha|barbear/],
    ["fitness", /fitness|academia|treino|esportivo|short|bermuda|top|cropped|legging|suplex|ciclista|sutia|baby doll|pijama|moda praia/],
    ["moda", /moda|roupa|vestido|calca|camiseta|blusa|tenis|sapato|sandalia|bolsa|carteira|relogio feminino/],
    ["casa", /casa|decor|quarto|sala|banheiro|cama|mesa|banqueta|tapete|cortina|moveis|mobiliario/],
    ["utilidades", /utilidade|ferramenta|automotivo|carro|pet|jardim|limpeza|organiz|suporte|acessorio/]
  ];
  for (const [categoria, regex] of grupos) if (regex.test(texto)) return categoria;
  return "utilidades";
}

async function analisarImagemDiretor(p) {
  const imagem = String(p.imagem || p.imageUrl || "").trim();
  if (!imagem) return { status: "sem_imagem", fatos_visiveis: [], lacunas: ["Nenhuma imagem de anúncio disponível."] };
  try {
    const u = new URL(imagem);
    const host = u.hostname.toLowerCase();
    const hostPermitido = h => /(^|\.)susercontent\.com$|(^|\.)shopee\.com(?:\.br)?$/i.test(String(h || "").toLowerCase());
    if (u.protocol !== "https:" || !hostPermitido(host)) {
      return { status: "imagem_nao_permitida", fatos_visiveis: [], lacunas: ["O endereço da imagem não usa HTTPS ou não pertence aos domínios oficiais de imagem da Shopee."] };
    }
    const resposta = await fetch(u.href, { redirect: "follow", signal: AbortSignal.timeout(12000), headers: { "User-Agent": "Mozilla/5.0 ShopeeFilaDirector/1.0" } });
    if (!resposta.ok) throw new Error("Download da imagem retornou HTTP " + resposta.status);
    const hostFinal = new URL(resposta.url || u.href).hostname;
    if (!hostPermitido(hostFinal)) throw new Error("A imagem foi redirecionada para um domínio externo não autorizado.");
    const tipo = String(resposta.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!tipo.startsWith("image/")) throw new Error("O endereço não retornou uma imagem.");
    const tamanho = Number(resposta.headers.get("content-length") || 0);
    if (tamanho > 5 * 1024 * 1024) throw new Error("A imagem excede 5 MB.");
    const bytes = Buffer.from(await resposta.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024) throw new Error("A imagem excede 5 MB.");
    const modelo = await modeloGeminiDiretor();
    const promptImagem = "Analise visualmente a imagem de anúncio de um produto para um sistema de criação de vídeos comerciais. Retorne SOMENTE JSON válido com: {\"tipo_produto_aparente\":\"...\",\"fatos_visiveis\":[\"...\"],\"cor_aparente\":\"... ou desconhecida\",\"materiais_visiveis\":[\"...\"],\"componentes_visiveis\":[\"...\"],\"uso_que_pode_ser_demonstrado\":[\"...\"],\"lacunas\":[\"...\"],\"alertas_fidelidade\":[\"...\"]}. Descreva somente o que é claramente visível. Não deduza material, tamanho, qualidade, capacidade, função ou benefício apenas pela aparência. Se houver texto na imagem, transcreva somente o que estiver legível e identifique como texto do anúncio, não como verificação independente. Se a imagem tiver vários itens, diferencie o produto principal dos acessórios. Nunca invente.";
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + modelo + ":generateContent?key=" + process.env.GEMINI_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptImagem }, { inlineData: { mimeType: tipo, data: bytes.toString("base64") } }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } }
      }),
      signal: AbortSignal.timeout(18000)
    });
    const j = await r.json();
    const texto = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("\n");
    if (!r.ok || !texto) throw new Error("Gemini Vision HTTP " + r.status + ": " + JSON.stringify(j).slice(0, 350));
    return { status: "analisada", ...lerJson(texto) };
  } catch (e) {
    console.warn("Análise da imagem do Diretor IA:", e.message);
    return { status: "indisponivel", fatos_visiveis: [], lacunas: ["Não foi possível analisar a imagem: " + e.message] };
  }
}

export async function pesquisarEstrategia(p) {
  const nome = String(p.nome || p.productName || "produto").slice(0, 250);
  const categoria = categoriaDiretor(nome, p.categoria || p.category);
  const dadosProduto = {
    nome,
    item_id: p.item_id || p.itemId || null,
    descricao: p.descricao || p.description || p.detalhes || null,
    imagem_anuncio: p.imagem || p.imageUrl || null,
    link_produto: p.link_produto || p.productLink || null,
    variacao: p.variacao || p.variation || null,
    marca: p.marca || p.brand || null,
    modelo: p.modelo || p.model || null,
    cor: p.cor || p.color || null,
    quantidade: p.quantidade || p.quantity || null,
    caracteristicas: p.caracteristicas || p.features || null
  };
  for (const k of Object.keys(dadosProduto)) {
    if (dadosProduto[k] === null || dadosProduto[k] === "") delete dadosProduto[k];
  }

  const analiseImagem = await analisarImagemDiretor(p);
  let aprendizados = [];
  try {
    let q = db().from("diretor_ia_memoria")
      .select("produto_nome,categoria,formato_escolhido,angulo_escolhido,gancho,estrutura_cenas,feedback,observacao,criado_em")
      .order("criado_em", { ascending: false })
      .limit(80);
    if (p.id) q = q.neq("produto_id", p.id);
    const { data, error } = await q;
    if (error) console.warn("Memória Diretor IA:", error.message);
    else aprendizados = (data || []).filter(x => categoriaDiretor(x.produto_nome, x.categoria) === categoria).slice(0, 10);
  } catch (e) { console.warn("Memória Diretor IA indisponível:", e.message); }

  const fontes = await pesquisarWebProduto(nome, categoria);
  let historicoProduto = [];
  try {
    if (p.id) {
      const { data, error } = await db().from("diretor_ia_memoria")
        .select("formato_escolhido,angulo_escolhido,gancho,feedback,observacao,criado_em")
        .eq("produto_id", p.id)
        .order("criado_em", { ascending: false })
        .limit(6);
      if (error) console.warn("Histórico do produto:", error.message);
      else historicoProduto = data || [];
    }
  } catch (e) { console.warn("Histórico do produto indisponível:", e.message); }

  const historicoTexto = historicoProduto.length
    ? JSON.stringify(historicoProduto.map(x => ({ formato: x.formato_escolhido, angulo: x.angulo_escolhido, gancho: x.gancho, avaliacao: x.feedback, observacao: x.observacao })))
    : "Nenhuma estratégia anterior registrada para este produto.";
  const memoriaTexto = aprendizados.length
    ? JSON.stringify(aprendizados.map(x => ({
        produto: x.produto_nome, formato: x.formato_escolhido, angulo: x.angulo_escolhido,
        gancho: x.gancho, avaliacao: x.feedback, observacao: x.observacao
      })))
    : "Ainda não há aprendizados anteriores nesta categoria.";

  const prompt = [
    "Você é diretor de publicidade e performance especializado em vídeos curtos de afiliados da Shopee Brasil. Não seja apenas um gerador de cenas: pense como um vendedor consultivo e diretor audiovisual.",
    "OBJETIVO: criar uma peça curta que prenda atenção, demonstre um benefício real, reduza uma objeção e estimule o clique. Não prometa vendas, viralização ou resultados.",
    "DADOS DO PRODUTO: " + JSON.stringify(dadosProduto),
    "ANÁLISE VISUAL DA IMAGEM (fatos visíveis e lacunas): " + JSON.stringify(analiseImagem),
    "HISTÓRICO DO PRODUTO: " + historicoTexto,
    "MEMÓRIA DA CATEGORIA " + categoria + ": " + memoriaTexto,
    "FONTES E REFERÊNCIAS PÚBLICAS: " + JSON.stringify(fontes),
    "ETAPA 1 — VERDADE DO PRODUTO: separe mentalmente fatos confirmados, fatos visíveis na imagem e lacunas. Use os dados do anúncio e a análise visual para fidelidade. Pesquisa web serve apenas para inspiração criativa, nunca como prova de atributos do produto. Não invente preço, desconto, material, medidas, funções, certificações, compatibilidade, capacidade, resultados ou acessórios.",
    "ETAPA 2 — ESCOLHA DO ÂNGULO: avalie três ângulos diferentes entre demonstração prática, problema e solução, unboxing, curiosidade, comparação de características, organização/rotina, presente/ocasião, transformação de ambiente ou UGC conversacional. Escolha os três mais adequados ao produto. Dê notas de 0 a 10 para demonstrabilidade, clareza do benefício, novidade frente à memória e risco de afirmação não comprovada. Escolha um ângulo e explique por que venceu. Penalize repetir ângulos e ganchos recentes da categoria, principalmente os rejeitados.",
    "ETAPA 3 — ROTEIRO: escolha uma mensagem central e um público provável. Comece com ação visual imediatamente, sem logotipo ou introdução longa. Demonstre o produto em uso quando isso for possível e seguro. Trate no máximo uma objeção. Feche com CTA natural: conferir o produto no link/Shopee. Não simule depoimento ou experiência pessoal que não aconteceu.",
    "ETAPA 4 — CLIPES GOOGLE FLOW: divida o vídeo em 2 a 4 clipes independentes, cada um com duração inteira de 4 a 10 segundos. A duração total deve ficar entre 16 e 30 segundos e ser exatamente a soma dos clipes. Retorne OBRIGATORIAMENTE EXATAMENTE 3 clipes de 6 segundos cada (total 18s). Nunca retorne somente um clipe. Cada clipe deve ser uma parte diferente: 1) gancho, 2) demonstração, 3) fechamento com CTA. Não economize omitindo clipes. Preencha duracao_segundos de cada clipe com número inteiro e repita a duração exata no início do prompt_flow. Nunca use intervalos de tempo cumulativos como duração de clipe; a duração é individual. Cada clipe precisa funcionar como prompt separado para Flow e ter prompt_flow completo, específico e pronto para colar (idealmente 500 a 900 caracteres por clipe). Estruture cada clipe com: formato 9:16 e duração; descrição precisa do produto baseada na imagem; pessoa/ambiente; enquadramento e lente; ação física contínua com começo, meio e fim; movimento de câmera; luz; fala exata em português brasileiro; texto na tela; áudio ambiente; continuidade; e restrições para evitar deformações. Não use frases telegráficas ou apenas listas de atributos. Uma ação principal por clipe. As falas devem caber naturalmente no tempo (aproximadamente 2 a 2,5 palavras por segundo).",
    "ETAPA 4A — SE FOR ROUPA OU MODA FITNESS: a pessoa deve vestir exatamente o conjunto/peça da imagem de referência, sem adicionar outra roupa por cima, sem trocar cor, corte, estampa ou modelo. Mostrar o look em plano médio e corpo inteiro, com movimentos naturais e elegantes: virar levemente de frente para o lado, caminhar poucos passos, fazer movimento de treino leve e seguro quando fizer sentido. Só demonstrar bolso se ele estiver visível/confirmado; só colocar celular no bolso se o bolso estiver claramente presente. Nunca mandar levantar, puxar ou expor a roupa, nem fazer enquadramento sexualizado. Não inventar tecido, compressão, sustentação, transparência ou caimento. A alegação 'zero transparência' só pode ser atribuída ao anúncio, não tratada como algo comprovado pela foto. O objetivo é mostrar o conjunto vestindo bem e em uso real, com a peça sempre visível.",
    "CONTINUIDADE: crie um bloco de continuidade com identidade visual da pessoa (se houver), roupa EXATAMENTE igual à referência do produto, cenário, objetos de cena, iluminação, estilo de câmera e posição do produto. Repita as instruções essenciais desse bloco em TODOS os prompts de clipe. Se não houver necessidade de pessoa, não force uma modelo. Não descreva roupa alternativa que cubra o produto.",
    "FIDELIDADE VISUAL: a imagem do anúncio é referência prioritária. Preserve forma, cor, proporções, estampa, marca, embalagem, componentes e quantidade visíveis. Não acrescente acessórios nem invente detalhes. Evite alterações de design, mãos deformadas, contato impossível, movimentos bruscos ou transições que escondam o item. Para roupas, não crie camadas de roupa que escondam a peça anunciada.",
    "PROMPT FINAL: prompt_video deve ser um pacote pronto para copiar, com formato 9:16, estilo UGC comercial realista, bloco de continuidade e prompts separados numerados para cada clipe. Cada prompt deve conter todas as instruções necessárias sem depender de contexto externo, inclusive produto de referência, ação, câmera, fala, texto, áudio e restrições negativas. Não entregue uma descrição genérica.",
    "VALIDAÇÃO: a soma das durações dos clipes deve ser igual a duracao_segundos. Cada clipe precisa ter de 4 a 10 segundos. A fala deve caber no tempo. Nenhuma afirmação pode exceder os dados ou o que está visível. Nota 0–100 mede adequação criativa estimada, não conversão.",
    "RETORNE SOMENTE JSON válido, sem markdown, com este formato: " +
    JSON.stringify({
      categoria: categoria,
      publico_alvo: "perfil provável, sem estereótipos",
      beneficio_principal: "benefício demonstrável",
      angulos_avaliados: [{ angulo: "nome", demonstrabilidade: 0, clareza_beneficio: 0, novidade: 0, risco_fidelidade: 0, motivo: "..." }],
      angulo_escolhido: "...",
      formato_escolhido: "...",
      nota_adequacao: 0,
      justificativa: "...",
      gancho: "...",
      duracao_segundos: 18,
      continuidade: { pessoa: "... ou sem pessoa", roupa: "...", cenario: "...", iluminacao: "...", camera: "..." },
      clipes: [{ numero: 1, duracao_segundos: 6, objetivo: "...", visual: "...", acao: "...", camera: "...", fala: "...", texto_tela: "...", prompt_flow: "prompt completo e individual para este clipe" }],
      estrutura_cenas: [{ momento: "0–6s", visual: "...", objetivo: "...", camera: "...", acao: "..." }],
      narracao: "...",
      textos_tela: ["..."],
      cta: "...",
      prompt_video: "pacote completo pronto para copiar, com todos os prompts por clipe",
      alertas: ["..."],
      fontes_utilizadas: [{ titulo: "...", url: "...", contribuicao: "..." }],
      limites_pesquisa: "..."
    }) + ". Todos os campos devem conter dados reais da análise; não mantenha exemplos genéricos do esquema."
  ].join("\n\n");

  const resultado = await iaJsonDiretor(prompt);
  const clipes = resultado.clipes.map((c, i) => ({
    ...c,
    numero: Number(c.numero || i + 1),
    duracao_segundos: Number(c.duracao_segundos),
    prompt_flow: String(c.prompt_flow || "").trim()
  }));
  const duracao = clipes.reduce((s, c) => s + c.duracao_segundos, 0);
  if (duracao !== Number(resultado.duracao_segundos) || clipes.some(c => c.duracao_segundos < 4 || c.duracao_segundos > 10 || !c.prompt_flow)) {
    throw new Error("A estratégia retornada não passou na validação dos clipes. Gere novamente.");
  }
  if (duracao < 16 || duracao > 30) throw new Error("A duração total deve ficar entre 16 e 30 segundos.");
  const promptVideo = String(resultado.prompt_video || "").trim().slice(0, 12000);
  if (!resultado.formato_escolhido || !promptVideo) throw new Error("A IA não retornou uma estratégia completa.");
  const estrategia = {
    ...resultado,
    categoria,
    analise_imagem: analiseImagem,
    fontes_pesquisadas: fontes,
    clipes,
    estrutura_cenas: Array.isArray(resultado.estrutura_cenas) && resultado.estrutura_cenas.length
      ? resultado.estrutura_cenas
      : clipes.map(c => ({ momento: c.duracao_segundos + "s", visual: c.visual, objetivo: c.objetivo, camera: c.camera, acao: c.acao })),
    pesquisado_em: new Date().toISOString(),
    prompt_video: promptVideo,
    memoria_utilizada: aprendizados.length
  };

  try {
    const { error } = await db().from("diretor_ia_memoria").insert({
      produto_id: p.id || null,
      item_id: p.item_id || null,
      produto_nome: nome,
      categoria,
      formato_escolhido: estrategia.formato_escolhido,
      angulo_escolhido: estrategia.angulo_escolhido || null,
      gancho: estrategia.gancho || null,
      estrutura_cenas: estrategia.estrutura_cenas || [],
      narracao: estrategia.narracao || null,
      prompt_video: promptVideo,
      estrategia,
      feedback: "sem_avaliacao"
    });
    if (error) console.warn("Não foi possível registrar memória:", error.message);
  } catch (e) { console.warn("Não foi possível registrar memória:", e.message); }
  return estrategia;
}
