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
// Prefere modelo menor e evita uma chamada extra à API de listagem de modelos.
const modeloGroq = () => (pGroq ??= Promise.resolve(process.env.GROQ_MODEL || "openai/gpt-oss-20b"));
async function groq(prompt) {
  try {
    const model = await modeloGroq();
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({model,messages:[{role:"user",content:prompt}],max_completion_tokens:1400,response_format:{type:"json_object"}}),
      signal:AbortSignal.timeout(4500)
    });
    const j=await r.json();
    if(!r.ok || !j.choices) throw new Error("Groq HTTP "+r.status+": "+JSON.stringify(j).slice(0,240));
    return lerJson(j.choices[0].message.content);
  } catch(e){pGroq=undefined;throw e;}
}
const modeloGemini = () => (pGemini ??= (async () => {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${process.env.GEMINI_API_KEY}`),j=await r.json(); if(!j.models) throw new Error("Gemini modelos: "+JSON.stringify(j).slice(0,200));
  const nomes=j.models.filter(m=>(m.supportedGenerationMethods||[]).includes("generateContent")).map(m=>m.name.replace("models/",""));
  return nomes.filter(n=>/^gemini-\d+(\.\d+)?-flash$/.test(n)).sort((a,b)=>parseFloat(b.split("-")[1])-parseFloat(a.split("-")[1]))[0] || nomes.find(n=>/flash/.test(n)&&!/image|tts|live|embed/.test(n)) || nomes[0];
})());
async function gemini(prompt) {
  try {
    const model=await modeloGemini();
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:1400}}),
      signal:AbortSignal.timeout(4500)
    });
    const j=await r.json();
    if(!r.ok || !j.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Gemini HTTP "+r.status+": "+JSON.stringify(j).slice(0,240));
    return lerJson(j.candidates[0].content.parts[0].text);
  } catch(e){pGemini=undefined;throw e;}
}
async function iaJson(prompt){
  const erros=[];
  for(const [nome,chamar] of [["Groq",groq],["Gemini",gemini]]){
    try{return await chamar(prompt)}catch(e){erros.push(nome+": "+e.message);console.error("IA:",nome,e.message)}
  }
  throw new Error("Os serviços de IA não responderam. "+erros.join(" | "));
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
  const encontrados = [];
  for (const q of consultas) {
    try {
      const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ShopeeFilaResearch/1.0)", "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7" } });
      if (!r.ok) continue;
      const html = await r.text();
      const snippets = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
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
      encontrados.push(...snippets);
    } catch (e) { console.warn("Pesquisa web:", e.message); }
  }
  const vistos = new Set();
  return encontrados.filter(x => { if (vistos.has(x.url)) return false; vistos.add(x.url); return true; }).slice(0, 12);
}

export async function pesquisarEstrategia(p) {
  const nome = String(p.nome || p.productName || "produto").slice(0, 250);
  // Envia à IA todos os dados que realmente existem no cadastro do produto.
  // Métricas comerciais ficam fora do briefing criativo.
  const dadosProduto = {
    nome,
    item_id: p.item_id || p.itemId || null,
    categoria_cadastrada: p.categoria || p.category || null,
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
  const promptCategoria = `Classifique este produto em uma categoria comercial curta, sem inventar características. Dados: ${JSON.stringify(dadosProduto)}`;
  let categoria = "produto";
  try { const c = await iaJson(`Responda somente JSON: {"categoria":"..."}\\n${promptCategoria}`); categoria = String(c.categoria || categoria).slice(0, 80); } catch {}

  // Memória persistente: recupera aprendizados de produtos anteriores da mesma categoria.
  let aprendizados = [];
  try {
    const sb = db();
    let q = sb.from("diretor_ia_memoria")
      .select("produto_nome,categoria,formato_escolhido,gancho,estrutura_cenas,narracao,feedback,observacao,criado_em")
      .ilike("categoria", categoria)
      .order("criado_em", { ascending: false })
      .limit(8);
    if (p.id) q = q.neq("produto_id", p.id);
    const { data, error } = await q;
    if (error) console.warn("Memória Diretor IA:", error.message);
    else aprendizados = data || [];
  } catch (e) { console.warn("Memória Diretor IA indisponível:", e.message); }

  const fontes = await pesquisarWebProduto(nome, categoria);
  // Recupera também as estratégias anteriores do mesmo produto para variar a abordagem.
  let historicoProduto = [];
  try {
    if (p.id) {
      const { data, error } = await db().from("diretor_ia_memoria")
        .select("formato_escolhido,gancho,feedback,observacao,criado_em")
        .eq("produto_id", p.id)
        .order("criado_em", { ascending: false })
        .limit(6);
      if (error) console.warn("Histórico do produto:", error.message);
      else historicoProduto = data || [];
    }
  } catch (e) { console.warn("Histórico do produto indisponível:", e.message); }
  const historicoTexto = historicoProduto.length
    ? JSON.stringify(historicoProduto.map(x => ({ formato: x.formato_escolhido, gancho: x.gancho, avaliacao: x.feedback, observacao: x.observacao })))
    : "Nenhuma estratégia anterior registrada para este produto.";
  const memoriaTexto = aprendizados.length
    ? JSON.stringify(aprendizados.map(x => ({
        produto: x.produto_nome, formato: x.formato_escolhido, gancho: x.gancho,
        cenas: x.estrutura_cenas, narracao: x.narracao, avaliacao: x.feedback,
        observacao: x.observacao
      })))
    : "Ainda não há aprendizados anteriores nesta categoria. Faça uma análise independente e registre esta primeira experiência.";

  const prompt = `Você é diretor de criação e roteirista especialista em vídeos curtos de produtos para afiliados da Shopee Brasil. Analise o produto e crie uma estratégia de vídeo que pareça conteúdo real de uma criadora/influenciadora, seja convincente, natural e visualmente claro. O objetivo é informar e despertar interesse de compra, sem inventar características.

BRIEFING REAL DO PRODUTO (dados recuperados do cadastro): ${JSON.stringify(dadosProduto)}
INFORMAÇÕES AUSENTES: não interrompa a criação nem dê nota baixa apenas porque o cadastro não informa cor, modelo, quantidade ou detalhes. Crie uma estratégia útil usando o que está confirmado. Quando faltarem detalhes, proponha planos visuais neutros que mostrem o próprio item do anúncio, sem nomear nem afirmar características desconhecidas. Não invente falas específicas sobre tecido, bolso, elasticidade, composição, tamanho, acessórios ou funções. Se o nome for genérico, use uma apresentação visual segura e deixe claro em alertas quais detalhes devem ser conferidos na imagem original antes de gravar.
NOTA CRIATIVA: avalie a qualidade da ideia e sua adequação ao formato, não a quantidade de campos preenchidos no cadastro. Uma estratégia visual genérica, mas fiel, pode receber nota razoável; não use 10/100 apenas por ausência de dados.
HISTÓRICO DESTE MESMO PRODUTO: ${historicoTexto}
APRENDIZADOS DE OUTROS PRODUTOS DA CATEGORIA: ${memoriaTexto}
PRODUTO E FIDELIDADE: use somente informações comprovadas nos dados fornecidos e no anúncio original. Preserve exatamente modelo, cor, formato, estampa, marca, quantidade, acessórios e demais detalhes que puderem ser confirmados. O produto anunciado deve ser sempre o protagonista. Não invente materiais, funções, resultados, medidas, benefícios ou acessórios. Não faça afirmações absolutas como "zero transparência", "à prova d'água", "indestrutível", "resultado garantido" ou equivalentes, a menos que isso esteja explicitamente comprovado. Quando uma característica não estiver confirmada, mostre apenas o que é visível e descreva com neutralidade.

FORMATO E DURAÇÃO: vídeo vertical 9:16 para TikTok, Reels e Shopee Video. Escolha duração entre 15 e 30 segundos conforme a quantidade de informações que realmente vale demonstrar; prefira 18 a 25 segundos. A duração escolhida deve ser respeitada pelo roteiro e pelo prompt final.

ROTEIRO OBRIGATÓRIO: crie uma sequência de cenas com tempos que somem exatamente a duração total. Para cada cena, informe intervalo/tempo, imagem e ação, enquadramento ou movimento de câmera e objetivo. Comece com um gancho visual forte nos primeiros 1–2 segundos, mostrando o produto ou seu principal detalhe — não comece com apresentação longa, tela vazia ou logotipo. Em seguida, mostre o produto em uso real e seus detalhes importantes. Termine com uma chamada clara para conferir/comprar o produto na Shopee. Use cortes e transições simples e coerentes; não acelere tanto que impeça entender o produto.

FALA DA INFLUENCIADORA: quando uma pessoa falando ajudar a vender/explicar, escreva a frase exata de abertura e todas as falas, em português brasileiro natural, como alguém recomendando um produto de verdade. Nunca deixe instruções vagas como "fala uma frase de abertura". A fala deve caber no tempo disponível, soar espontânea e explicar o produto sem exagero. Se o produto for melhor apresentado sem fala, justifique e use demonstração visual com textos curtos. Não invente depoimentos, experiência pessoal, teste ou opinião como se fossem reais.

DEMONSTRAÇÃO E NATURALIDADE: descreva ações específicas e plausíveis que comprovem o uso: mãos manipulando o item, pessoa vestindo/usando, abrindo, encaixando, ligando ou demonstrando a função — somente quando aplicável ao produto. Mostre detalhes úteis em close-up. Para roupas, por exemplo, mostre frente, costas, caimento, costuras, cós, bolsos e tecido em movimento; se houver bolso, mostre o celular sendo colocado e retirado; só demonstre forro, elasticidade ou opacidade se isso estiver visível/comprovado. Para eletrônicos, mostre controles e funções reais. Para itens domésticos, mostre o uso cotidiano. As pessoas devem se mover de forma fluida e anatomicamente natural, sem poses robóticas, gestos bruscos, mãos deformadas, movimentos impossíveis ou contato incorreto com o produto. Preserve a continuidade da roupa, aparência da pessoa, cenário, iluminação e produto entre as cenas. Evite mostrar pele ou partes do corpo de forma desnecessária; enquadre para valorizar o produto com respeito e naturalidade.

DIREÇÃO VISUAL: aparência profissional, iluminação que revele detalhes reais, enquadramentos variados (plano médio e close-ups), câmera estável com movimentos suaves e foco nítido no produto. Use cenário compatível com o uso real do item. A influenciadora, quando usada, deve interagir com o produto e olhar para a câmera nos momentos de fala; não deve apenas posar. Não use estética artificial exagerada nem efeitos que escondam o produto.

TEXTOS NA TELA E ÁUDIO: proponha poucos textos curtos, legíveis e sincronizados com o detalhe mostrado. Cada afirmação deve ser comprovada pelos dados/imagens. Inclua legendas em português brasileiro para todas as falas. Sugira música de fundo discreta que não cubra a voz; não dependa de música protegida específica. Evite excesso de textos, emojis e efeitos.

CTA: encerre com uma chamada compatível com a plataforma, como "Toque no link do produto e confira na Shopee" ou "Confira este produto na Shopee". Não use "arraste para cima", pois esse recurso pode não existir no formato/plataforma. Não prometa desconto, preço ou disponibilidade.

PESQUISA E MEMÓRIA: use referências públicas e aprendizados anteriores apenas como inspiração de apresentação. Não trate resultados de busca como prova das características do produto. Aproveite estratégias aprovadas e evite abordagens rejeitadas, mas nunca sacrifique a fidelidade ao produto atual. Não invente métricas de visualização, vendas ou conversão.

SAÍDA: retorne uma estratégia prática e pronta para produção, com gancho, duração, cenas cronometradas, falas exatas quando houver, textos na tela, CTA, prompt final completo para a ferramenta de vídeo e alertas sobre características que não podem ser afirmadas. O prompt final deve repetir as instruções essenciais de fidelidade visual, naturalidade, continuidade e áudio. Não limite o prompt final a uma descrição genérica: ele precisa conter as ações e falas específicas definidas no roteiro.

Responda SOMENTE JSON válido neste formato:
{"categoria":"...","formato_escolhido":"...","nota_adequacao":0,"justificativa":"...","padroes_observados":["..."],"gancho":"...","duracao_segundos":18,"estrutura_cenas":[{"momento":"0–2s","visual":"...","objetivo":"...","camera":"...","acao":"..."}],"narracao":"...","textos_tela":["..."],"cta":"...","prompt_video":"...","alertas":["..."],"fontes_utilizadas":[{"titulo":"...","url":"...","contribuicao":"..."}],"limites_pesquisa":"..."}
A soma dos tempos das cenas deve ser igual a duracao_segundos. A fala deve estar escrita integralmente, nunca apenas indicada. A nota é de adequação criativa estimada (0–100), não previsão de visualizações ou vendas. Use somente fontes listadas acima em fontes_utilizadas; se nenhuma for confiável, deixe a lista vazia e diga isso em limites_pesquisa.`

;
  const resultado = await iaJson(prompt);
  const promptVideo = String(resultado.prompt_video || "").slice(0, 4000);
  if (!resultado.formato_escolhido || !promptVideo) throw new Error("A IA não retornou uma estratégia completa.");
  const estrategia = {
    ...resultado,
    categoria,
    fontes_pesquisadas: fontes,
    pesquisado_em: new Date().toISOString(),
    prompt_video: promptVideo,
    memoria_utilizada: aprendizados.length
  };

  // Registra cada consulta como experiência para as próximas análises.
  try {
    const { error } = await db().from("diretor_ia_memoria").insert({
      produto_id: p.id || null,
      item_id: p.item_id || null,
      produto_nome: nome,
      categoria,
      formato_escolhido: estrategia.formato_escolhido,
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
