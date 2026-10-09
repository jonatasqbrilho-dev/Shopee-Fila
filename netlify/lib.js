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

const lerJson = (t) => JSON.parse(String(t).replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/)?.[0] || "{}");
let pGroq, pGemini;
const modeloGroq = () => (pGroq ??= (async () => {
  if (process.env.GROQ_MODEL) return process.env.GROQ_MODEL;
  const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }); const j = await r.json();
  if (!j.data) throw new Error("Groq modelos: " + JSON.stringify(j).slice(0, 200));
  const ids = j.data.map(m => m.id).filter(id => !/whisper|tts|guard|embed|compound|orpheus/i.test(id));
  return [/llama-3\.3-70b/, /gpt-oss-120b/, /llama-4|maverick|scout/, /gpt-oss-20b/, /llama/].map(re => ids.find(id => re.test(id))).find(Boolean) || ids[0];
})());
async function groq(prompt) {
  try { const model = await modeloGroq(); const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method:"POST", headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"}, body:JSON.stringify({model,messages:[{role:"user",content:prompt}]} )}); const j=await r.json(); if(!j.choices) throw new Error("Groq: "+JSON.stringify(j).slice(0,200)); return lerJson(j.choices[0].message.content); } catch(e){pGroq=undefined;throw e;}
}
const modeloGemini = () => (pGemini ??= (async () => {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${process.env.GEMINI_API_KEY}`),j=await r.json(); if(!j.models) throw new Error("Gemini modelos: "+JSON.stringify(j).slice(0,200));
  const nomes=j.models.filter(m=>(m.supportedGenerationMethods||[]).includes("generateContent")).map(m=>m.name.replace("models/",""));
  return nomes.filter(n=>/^gemini-\d+(\.\d+)?-flash$/.test(n)).sort((a,b)=>parseFloat(b.split("-")[1])-parseFloat(a.split("-")[1]))[0] || nomes.find(n=>/flash/.test(n)&&!/image|tts|live|embed/.test(n)) || nomes[0];
})());
async function gemini(prompt) {
  try { const model=await modeloGemini(); const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json"}})}),j=await r.json(); if(!j.candidates) throw new Error("Gemini: "+JSON.stringify(j).slice(0,200)); return lerJson(j.candidates[0].content.parts[0].text); } catch(e){pGemini=undefined;throw e;}
}
async function iaJson(prompt){for(const chamar of [groq,gemini]){try{return await chamar(prompt)}catch(e){console.error("IA:",e.message)}}throw new Error("IA indisponível");}

export async function avaliar(p) {
  const prompt=`Você avalia produtos da Shopee Brasil para divulgação como afiliado. Responda SOMENTE um JSON válido com os campos: {"nota": inteiro de 0 a 100, "motivo": "justificativa curta da nota", "legenda": "legenda pronta para publicar"}.\n\nCrie uma legenda de divulgação fiel ao anúncio: comece com um gancho curto, use 1 a 3 emojis, destaque somente benefícios/usos comprovados pelo nome e pelos dados do produto e termine com uma chamada natural para conferir o produto no link. NÃO invente funções, materiais, qualidade, resultados, medidas, compatibilidade, certificações, marca, variação, desconto ou qualquer característica que não esteja comprovada. A legenda deve deixar claro qual é o produto e não pode promover outro item, acessório ou produto semelhante.\n\nREGRA DE RELEVÂNCIA SHOPEE: o conteúdo deve corresponder exatamente ao produto vinculado. Não trate produto parecido como se fosse o mesmo. Respeite marca, modelo, cor, tamanho, capacidade, voltagem, fragrância, sabor, material, acabamento, quantidade e composição quando essas informações estiverem disponíveis. Se for kit, deixe a quantidade/composição clara somente quando constar nos dados.\n\nNÃO inclua preço, valor em reais, porcentagem de desconto ou promessa de promoção. Inclua de 8 a 12 hashtags relevantes no final da própria legenda, separadas por espaços, sempre relacionadas ao produto e ao uso real. Evite hashtags que indiquem características não comprovadas. Escreva em português brasileiro, com texto natural e sem exageros.\n\nProduto: ${JSON.stringify(p)}`;
  const r=await iaJson(prompt); const nota=Math.round(Number(r.nota)); if(!Number.isFinite(nota)) throw new Error("IA sem nota válida"); return {...r,nota:Math.min(100,Math.max(0,nota))};
}

const limitarPrompt=texto=>{let s=String(texto||"");if(s.length<=850)return s;return s.slice(0,850).replace(/\s+\S*$/," ").trim();};
const removerPreco=texto=>String(texto||"").replace(/R\$\s?\d+(?:[.,]\d{2})?/gi,"").replace(/\b\d+[.,]\d{2}\s?(?:reais)?\b/gi,"").replace(/\b(?:por|de|a partir de)\s+\d+(?:[.,]\d{2})?\s?(?:reais|R\$)?\b/gi,"").replace(/\s{2,}/g," ").trim();

export async function gerarConteudo(p) {
  const prompt=`Você é um especialista em criação de PROMPTS para vídeos de produtos da Shopee Brasil. Sua tarefa é gerar UM único prompt de direção para uma IA de vídeo. O objetivo é aumentar atenção, retenção, desejo e intenção de compra, sem inventar informações.

REGRAS DE FORMATO: vídeo vertical 9:16, duração entre 20 e 30 segundos, preferencialmente cerca de 25 segundos, ritmo dinâmico e profissional, usando prioritariamente as IMAGENS REAIS do anúncio como referência do produto.

IMPORTANTE: NÃO crie roteiro por segundos, não divida o vídeo em intervalos como 0-3s, 3-7s etc. NÃO determine uma sequência obrigatória de cenas. NÃO diga à IA exatamente o que fazer em cada segundo. O prompt deve apenas fornecer as regras, objetivos, características do produto e restrições. A IA DE VÍDEO deve decidir autonomamente as cenas, enquadramentos, movimentos de câmera, transições, cortes, timing e forma de apresentar o produto.

DIREÇÃO CRIATIVA: crie um vídeo atraente e com potencial de conversão, mantendo o produto como protagonista. Valorize visualmente o produto, destaque seus benefícios e usos reais quando comprovados, gere desejo e sensação de praticidade e mantenha ritmo adequado para conteúdo curto. A IA de vídeo pode escolher livremente a melhor composição visual e narrativa, desde que respeite todas as regras abaixo.

FIDELIDADE ABSOLUTA AO PRODUTO:
- Apresente EXATAMENTE o produto vinculado ao anúncio.
- Use as imagens reais do anúncio como principal referência visual.
- Preserve fielmente aparência, formato, cor, marca/logo, modelo, tamanho, capacidade, voltagem, embalagem, quantidade, acessórios, materiais e acabamento visíveis ou informados no anúncio.
- Não substitua por produto parecido, modelo diferente, marca diferente ou outra variação.
- Não invente funções, especificações, medidas, materiais, resultados, certificações, compatibilidades, acessórios ou benefícios.
- Não altere o design, formato, cor ou características do produto para deixá-lo mais bonito.
- Não adicione produtos concorrentes ou itens que possam ser confundidos com produtos vendidos no anúncio.
- Se for kit ou conjunto, respeite exatamente a composição indicada.

TEXTO E PROMESSAS: qualquer texto na tela deve ser mínimo, legível e baseado somente em informações comprovadas. Não faça promessas exageradas, resultados garantidos, escassez falsa ou afirmações não comprovadas.

PREÇO: NÃO mostrar, escrever, falar ou mencionar preço, valor em reais, desconto, porcentagem de desconto ou promoção de preço.

O resultado deve ser adequado para Shopee Video, com foco no produto real e em seus benefícios comprovados. Não gere roteiro, storyboard, narração, legenda, hashtags ou explicações. Gere SOMENTE JSON válido no formato {"video_prompt":"..."}. O campo video_prompt deve ter no máximo 850 caracteres, contando espaços. Escreva em português brasileiro.

Dados reais do produto: ${JSON.stringify({nome:p.nome,vendas:p.vendas,avaliacao:p.avaliacao,motivo:p.motivo,imagem:p.imagem})}`;
  const r=await iaJson(prompt);
  const texto=typeof r === "string" ? r : (r.video_prompt || r.prompt || "");
  const video_prompt=limitarPrompt(removerPreco(texto));
  if(!video_prompt) throw new Error("A IA não retornou um prompt válido. Tente novamente.");
  const a=await avaliar(p);
  if(!a?.legenda || !String(a.legenda).trim()) throw new Error("A IA não retornou uma legenda válida. Tente novamente.");
  return {video_prompt,nota:a.nota,motivo:a.motivo,legenda:a.legenda};
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