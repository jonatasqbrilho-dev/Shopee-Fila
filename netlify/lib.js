import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DURACAO_PADRAO_DIRETOR, LIMITE_FALA_DIRETOR, extrairQuantidadeKit, palavras, legendaSegura, palavraChaveProduto, validarGanchos, validarContinuidade, normalizarTexto } from "./diretor-validacao.js";

export const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
export const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
export const autorizado = (req) => !!process.env.PAINEL_SENHA && req.headers.get("x-senha") === process.env.PAINEL_SENHA;

export async function shopee(query) {
  const id = process.env.SHOPEE_APP_ID, payload = JSON.stringify({ query });
  const endpoint = "https://open-api.affiliate.shopee.com.br/graphql";
  const tentativas = 3;
  const errosRepetiveis = [10000, 10030];
  let ultimoErro;
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHash("sha256").update(id + ts + payload + process.env.SHOPEE_SECRET).digest("hex");
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `SHA256 Credential=${id}, Timestamp=${ts}, Signature=${sig}`
        },
        body: payload,
        signal: AbortSignal.timeout(15000)
      });
      const texto = await r.text();
      let j;
      try { j = JSON.parse(texto); }
      catch { throw new Error(`Shopee HTTP ${r.status}: resposta não JSON: ${texto.slice(0, 250)}`); }

      const erros = Array.isArray(j.errors) ? j.errors : [];
      const codigo = Number(erros[0]?.extensions?.code ?? erros[0]?.extensions?.errorCode ?? 0);
      const erroSistema = erros.some(e => /system error|internal server error|temporarily unavailable/i.test(String(e?.message || e?.extensions?.message || "")));
      const repetivel = erros.length && (errosRepetiveis.includes(codigo) || erroSistema);
      if (r.ok && !erros.length && j.data) return j.data;

      const detalhe = erros.length
        ? JSON.stringify(erros).slice(0, 700)
        : `Shopee HTTP ${r.status}: ${texto.slice(0, 350)}`;
      ultimoErro = new Error(detalhe);
      if (tentativa >= tentativas || (!repetivel && ![429, 500, 502, 503, 504].includes(r.status))) throw ultimoErro;
    } catch (e) {
      ultimoErro = e;
      const temporario = e?.name === "TimeoutError" || e?.name === "AbortError" || /fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(String(e?.message || ""));
      if (tentativa >= tentativas || (!temporario && !/system error|internal server error|temporarily unavailable|10000|10030/i.test(String(e?.message || "")))) throw e;
    }
    if (tentativa < tentativas) await new Promise(resolve => setTimeout(resolve, 800 * tentativa));
  }
  throw ultimoErro || new Error("Shopee API indisponível após novas tentativas.");
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
    const executar = async (usarFormatoJson, textoPrompt) => {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method:"POST",
        headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
        body:JSON.stringify({model,messages:[{role:"user",content:textoPrompt}],max_completion_tokens:options.maxTokens || 1400,...(options.reasoningEffort?{reasoning_effort:options.reasoningEffort}:{}),...(usarFormatoJson?{response_format:{type:"json_object"}}:{})}),
        signal:options.signal || AbortSignal.timeout(options.timeoutMs || 2500)
      });
      const j=await r.json();
      if(!r.ok || !j.choices?.[0]?.message?.content) throw new Error("Groq HTTP "+r.status+": "+JSON.stringify(j).slice(0,500));
      if (j.choices[0].finish_reason === "length") throw new Error("Groq cortou a resposta por limite de tokens.");
      return lerJson(j.choices[0].message.content);
    };
    try {
      return await executar(true, prompt);
    } catch (e) {
      // Alguns modelos Groq falham na validação do modo JSON estruturado.
      // Tenta uma vez sem response_format, mantendo a exigência explícita de JSON no prompt.
      if (!/json_validate_failed/i.test(String(e.message || e))) throw e;
      console.warn("Groq: modo JSON estruturado falhou; tentando resposta JSON pelo prompt.");
      return await executar(false, prompt + "\n\nIMPORTANTE: retorne somente um objeto JSON válido, sem Markdown, sem bloco de código e sem texto antes ou depois.");
    }
  } catch(e){pGroq=undefined;throw e;}
}
// Usa um modelo Flash estável sem consultar a lista de modelos a cada execução.
const modeloGemini = () => Promise.resolve(process.env.GEMINI_MODEL && process.env.GEMINI_MODEL !== "gemini-2.5-flash" ? process.env.GEMINI_MODEL : "gemini-3.8-flash");
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
// Se o modelo principal estiver sobrecarregado, tenta novamente e usa um Flash alternativo.
async function geminiDiretor(prompt, options = {}) {
  const principal = await modeloGeminiDiretor();
  const modelos = [...new Set([principal, "gemini-3-flash-preview"])];
  const erros = [];
  const repetiveis = [429, 500, 502, 503, 504];
  for (const model of modelos) {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: options.maxTokens || 4096, ...(options.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } } : {}) } }),
          signal: options.signal || AbortSignal.timeout(options.timeoutMs || 18000)
        });
        const j = await r.json().catch(() => ({}));
        const texto = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("\n");
        if (r.ok && texto) {
          if (j.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error("Gemini Diretor cortou a resposta por limite de tokens.");
          return lerJson(texto);
        }
        const detalhe = "Gemini Diretor " + model + " HTTP " + r.status + ": " + JSON.stringify(j).slice(0, 350);
        erros.push(detalhe);
        if (!repetiveis.includes(r.status)) throw new Error(detalhe);
      } catch (e) {
        if (e.name === "AbortError" || e.name === "TimeoutError") throw e;
        if (!erros.includes(e.message)) erros.push(e.message);
        if (!/HTTP (429|500|502|503|504)/.test(e.message)) throw e;
      }
      if (tentativa < 2) await new Promise(resolve => setTimeout(resolve, 900 * tentativa));
    }
  }
  throw new Error(erros.slice(-4).join(" | ") || "Modelos Gemini indisponíveis.");
}

async function iaJson(prompt){
  const erros=[];
  const controladores=[new AbortController(),new AbortController()];
  // A geração comum roda em paralelo para não gastar o tempo limite em dois provedores sequenciais.
  // 6 segundos por provedor e corte global em 6,5 s deixam margem para SEO e gravação no Netlify.
  const limite=setTimeout(()=>controladores.forEach(c=>c.abort()),6500);
  const provedores=[["Groq",groq],["Gemini",gemini]];
  try{
    const tarefas=provedores.map(async([nome,chamar],i)=>{
      try{
        return await chamar(prompt,{signal:controladores[i].signal,timeoutMs:6000});
      }catch(e){
        const detalhe=nome+": "+(e?.name==="AbortError"||e?.name==="TimeoutError"?"tempo limite excedido":e.message);
        erros.push(detalhe);
        console.error("IA:",detalhe);
        throw e;
      }
    });
    return await Promise.any(tarefas);
  }catch(e){
    throw new Error("Os serviços de IA não responderam. "+(erros.join(" | ")||"Os provedores não retornaram uma resposta válida."));
  }finally{
    clearTimeout(limite);
    controladores.forEach(c=>{if(!c.signal.aborted)c.abort();});
  }
}

// O Diretor IA produz uma estratégia extensa: usa os dois provedores em paralelo,
// com mais tempo e tokens, e encerra a chamada perdedora assim que uma resposta válida chega.
async function iaJsonDiretor(prompt, produtoNome = "produto", contextoProduto = {}) {
  const controladores = [new AbortController(), new AbortController()];
  const limite = setTimeout(() => controladores.forEach(c => c.abort()), 50000);
  const validar = async (chamar) => {
    const resposta = await chamar();
    if (!resposta?.formato_escolhido || !resposta?.prompt_video || !Array.isArray(resposta?.clipes) || !resposta.clipes.length || !Array.isArray(resposta?.ganchos) || resposta.ganchos.length !== 3) {
      throw new Error("O provedor retornou uma estratégia incompleta ou sem roteiro.");
    }
    // O Diretor IA entrega um único vídeo de 10 segundos, não uma sequência de clipes.
    const clipesOriginais = resposta.clipes.slice(0, 4);
    const primeiro = clipesOriginais[0] || {};
    const continuidade = resposta.continuidade || {};
    const ganchoPrincipal = (Array.isArray(resposta.ganchos) ? resposta.ganchos.find(g => g.tipo === "Demonstração") : null) || (Array.isArray(resposta.ganchos) ? resposta.ganchos[0] : null) || {};
    const juntar = (campo) => clipesOriginais.map(c => String(c?.[campo] || "").trim()).filter(Boolean).join(" ");
    const falaOriginal = String(primeiro.fala || resposta.narracao || "").trim();
    const nomeCurto = nomeCurtoFalado(produtoNome || resposta.produto_nome || resposta.produto);
    const nomeOriginal = String(produtoNome || "").trim();
    const falaComNomeCurto = nomeOriginal && falaOriginal.toLowerCase().includes(nomeOriginal.toLowerCase())
      ? falaOriginal.slice(0, falaOriginal.toLowerCase().indexOf(nomeOriginal.toLowerCase())) + nomeCurto + falaOriginal.slice(falaOriginal.toLowerCase().indexOf(nomeOriginal.toLowerCase()) + nomeOriginal.length)
      : falaOriginal;
    let fala = falaComNomeCurto
      ? falaComNomeCurto.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 16).join(" ")
      : "Olha só esse produto!";
    fala = fala.replace(/sem transparência[^.!?]*/ig, "").replace(/transparência[^.!?]*/ig, "").replace(/conforto total/ig, "praticidade").replace(/\s{2,}/g, " ").trim();
    if (!/\b(link|compre|comprar|garanta|garantir|confira)\b/i.test(fala)) fala = (fala ? fala.replace(/[.!?]+$/, "") + ". " : "") + "Clique no link e confira!";
    const detalhes = [
      "VÍDEO ÚNICO, CONTÍNUO E COMPLETO — duração EXATA de 10 segundos, formato vertical 9:16.",
      "Apresente o produto imediatamente no primeiro segundo. Escolha a melhor forma de apresentação para este item: uma pessoa falando diretamente com a câmera, demonstração com as mãos, uso real ou enquadramento do próprio produto. Não force uma modelo quando ela não acrescentar valor.",
      "Em uma única tomada fluida: 0–2s produto aparece imediatamente e prende atenção; 2–7s apresente uma característica confirmada com demonstração simples; 7–10s recomendação natural e CTA claro para clicar no link e conferir.",
      "A apresentação deve soar como uma pessoa real recomendando o produto a quem está assistindo: fala natural, simpática, segura, persuasiva e em português brasileiro. A fala deve caber integralmente em 10 segundos, com no máximo 22 palavras e sem acelerar. Na fala, use um NOME CURTO E NATURAL do produto (2 a 4 palavras), nunca leia o título comercial completo do anúncio.",
      "Produto anunciado (identificação visual; não ler o título completo): " + String(produtoNome || resposta.produto_nome || resposta.produto || "produto"),
      contextoProduto.quantidadeKit ? "QUANTIDADE OBRIGATÓRIA: o anúncio declara um kit com " + contextoProduto.quantidadeKit + " peças. Apresente exatamente essa quantidade; não confunda número de modelos/fotos com quantidade de peças. Se as cores/variações estiverem confirmadas nos dados ou imagem, mostre as variações corretas sem inventar outras." : "",
      "Nome curto obrigatório na fala: " + nomeCurto + ". Nunca pronuncie o título comercial completo.",
      continuidade.pessoa ? "Pessoa/apresentador: " + continuidade.pessoa : "Escolha apresentador, mãos ou demonstração sem pessoa conforme a melhor solução para o produto.",
      continuidade.roupa ? "Roupa: " + continuidade.roupa : "",
      continuidade.cenario ? "Cenário: " + continuidade.cenario : "",
      continuidade.iluminacao ? "Iluminação: " + continuidade.iluminacao : "",
      continuidade.camera ? "Câmera: " + continuidade.camera : "",
      "Gancho: " + String(ganchoPrincipal.texto || resposta.gancho || primeiro.objetivo || primeiro.visual || "Mostre o produto de forma atraente logo no início."),
      ganchoPrincipal.abertura_visual ? "Abertura visual: " + ganchoPrincipal.abertura_visual : "",
      "Demonstração: " + [String(primeiro.visual || ""), String(primeiro.acao || "")].filter(Boolean).join(" "),
      "Fala sugerida: " + fala,
      "Texto na tela: " + String(primeiro.texto_tela || (Array.isArray(resposta.textos_tela) ? resposta.textos_tela.join(" · ") : "") || "Confira no link"),
      "CTA obrigatório no final: convide a pessoa a clicar no link para comprar ou conferir o produto.",
      "Fidelidade: use a imagem do anúncio como referência principal; preserve exatamente cor, formato, modelo, quantidade e componentes visíveis. Não invente material, funções, resultados, descontos, avaliações ou características. Não prometa benefícios que não estejam confirmados.",
      "Naturalidade: movimentos simples e possíveis, expressão espontânea, sincronização labial correta se houver fala, mãos anatomicamente corretas, produto sempre nítido e sem deformações. Sem transições, sem montagem de cenas e sem mudança de roupa ou cenário.",
      "Áudio: voz clara em primeiro plano, música de fundo discreta e sem encobrir a fala."
    ].filter(Boolean).join("\n");
    const clipeUnico = {
      numero: 1,
      duracao_segundos: DURACAO_PADRAO_DIRETOR,
      objetivo: "Apresentar, demonstrar e vender o produto em um único vídeo",
      visual: juntar("visual") || primeiro.visual || "Produto em destaque desde o primeiro segundo.",
      acao: juntar("acao") || primeiro.acao || "Apresentação natural do produto, demonstração breve e CTA.",
      camera: juntar("camera") || primeiro.camera || "Enquadramento vertical estável com movimento suave.",
      fala,
      texto_tela: primeiro.texto_tela || "Confira no link",
      prompt_flow: detalhes
    };
    resposta.clipes = [clipeUnico];
    resposta.duracao_segundos = DURACAO_PADRAO_DIRETOR;
    resposta.gancho = ganchoPrincipal.texto || resposta.gancho;
    resposta.prompt_video = detalhes;
    resposta.estrutura_cenas = [{
      momento: "0–10s",
      visual: clipeUnico.visual,
      objetivo: clipeUnico.objetivo,
      camera: clipeUnico.camera,
      acao: clipeUnico.acao
    }];
    return resposta;
  };
  try {
    return await Promise.any([
      validar(() => groq(prompt, { signal: controladores[0].signal, maxTokens: 4096, reasoningEffort: "low" })),
      validar(() => geminiDiretor(prompt, { signal: controladores[1].signal, maxTokens: 4096, thinkingBudget: 0, timeoutMs: 18000 }))
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


// OpenSEO Lite: combina sugestões públicas do Google com termos locais gratuitos
// escolhidos pela categoria do produto. Não usa APIs pagas nem depende do navegador.
const SEO_STOPWORDS = new Set(["a","o","as","os","de","da","do","das","dos","com","sem","para","por","na","no","nas","nos","e","em","um","uma","kit"]);
const SEO_CATEGORIAS = [
  { nome:"Moda e roupas", teste:/\b(calça|calca|pantalona|blusa|camisa|camiseta|vestido|saia|short|bermuda|legging|sutiã|sutia|calcinha|cueca|jaqueta|casaco|macacão|macacao|conjunto|roupa|moda|fitness|top feminino)\b/i,
    termos:["como combinar","ideias de look","looks femininos","moda feminina","para o dia a dia","para trabalhar","estilo casual","tendências de moda"] },
  { nome:"Calçados", teste:/\b(tênis|tenis|sapato|sandália|sandalia|chinelo|bota|sapatilha|scarpin|rasteira)\b/i,
    termos:["como combinar","looks com","calçado feminino","calçado masculino","para o dia a dia","como escolher tamanho"] },
  { nome:"Beleza e cuidados pessoais", teste:/\b(maquiagem|batom|base facial|rímel|rimel|perfume|hidratante|shampoo|condicionador|creme|sérum|serum|protetor solar|escova secadora|modelador|unha|cabelo|skincare)\b/i,
    termos:["como usar","modo de aplicação","cuidados pessoais","rotina de beleza","dicas de beleza","para que serve"] },
  { nome:"Eletrônicos e informática", teste:/\b(fone|headphone|bluetooth|celular|smartphone|carregador|cabo usb|teclado|mouse|monitor|notebook|tablet|caixa de som|smartwatch|relógio inteligente|câmera|camera|microfone|adaptador)\b/i,
    termos:["como funciona","compatibilidade","como conectar","funções e recursos","para celular","avaliação do produto"] },
  { nome:"Casa e organização", teste:/\b(organizador|prateleira|armário|armario|gaveteiro|cabide|cesto|caixa organizadora|decoração|decoracao|tapete|cortina|almofada|luminária|luminaria|lâmpada|lampada|vaso|móvel|movel)\b/i,
    termos:["organização da casa","decoração de ambientes","como organizar","utilidades domésticas","para casa","dicas de organização"] },
  { nome:"Cozinha e utilidades", teste:/\b(cozinha|panela|frigideira|air fryer|fritadeira|liquidificador|processador|garrafa|térmica|termica|pote|forma|assadeira|talher|utensílio|utensilio|cafeteira|marmita)\b/i,
    termos:["utilidades para cozinha","como usar","preparo de alimentos","organização da cozinha","utensílios domésticos","facilita a rotina"] },
  { nome:"Pet", teste:/\b(pet|cachorro|cão|cao|gato|coleira|brinquedo pet|cama pet|comedouro|bebedouro|ração|racao)\b/i,
    termos:["acessórios para pets","cuidados com cães","cuidados com gatos","como escolher","rotina do pet","para cães e gatos"] },
  { nome:"Bebê e infantil", teste:/\b(bebê|bebe|infantil|criança|crianca|mamadeira|fralda|carrinho|berço|berco|brinquedo infantil|lancheira)\b/i,
    termos:["produtos infantis","rotina do bebê","uso infantil","como escolher","cuidados no dia a dia"] },
  { nome:"Esporte e fitness", teste:/\b(academia|fitness|musculação|musculacao|halter|anilha|elástico de treino|colchonete|yoga|corrida|bicicleta ergométrica)\b/i,
    termos:["acessórios para treino","treino em casa","atividade física","como usar","rotina fitness"] },
  { nome:"Automotivo", teste:/\b(carro|automóvel|automovel|moto|motocicleta|capacete|retrovisor|pneu|tapete automotivo|suporte veicular|peça automotiva)\b/i,
    termos:["acessórios automotivos","compatibilidade com veículo","instalação","como usar","cuidados com o veículo"] },
  { nome:"Ferramentas e construção", teste:/\b(furadeira|parafusadeira|broca|chave de fenda|alicate|serra|ferramenta|torneira|chuveiro|material elétrico|construção)\b/i,
    termos:["ferramentas para reparos","como instalar","como usar","manutenção","uso profissional e doméstico"] },
  { nome:"Brinquedos e lazer", teste:/\b(brinquedo|boneca|carrinho infantil|quebra-cabeça|jogo de tabuleiro|pelúcia|pelucia|lego)\b/i,
    termos:["brinquedos para crianças","ideias para brincar","presente infantil","como brincar","lazer em família"] },
  { nome:"Papelaria e escritório", teste:/\b(caderno|caneta|lápis|lapis|mochila|estojo|papelaria|agenda|grampeador|impressora|escritório)\b/i,
    termos:["material escolar","material de escritório","organização dos estudos","volta às aulas","itens de papelaria"] }
];
const seoNormalizar = texto => String(texto || "").toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
function detectarCategoriaSEO(nomeProduto) {
  const texto = seoNormalizar(nomeProduto);
  return SEO_CATEGORIAS.find(c => c.teste.test(texto)) || { nome:"Produto geral", termos:["como usar","características","para que serve","comprar","avaliação","vale a pena"] };
}
function termosLocaisSEO(nomeProduto, categoria) {
  const palavrasBase = String(nomeProduto || "").replace(/<[^>]*>/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  const qualificadores = [];
  const normalizado = seoNormalizar(nomeProduto);
  for (const termo of ["cintura alta","com bolso","tecido duna","manga longa","sem fio","recarregável","à prova d'água","inox","bivolt","usb","bluetooth"]) {
    if (normalizado.includes(seoNormalizar(termo))) qualificadores.push(termo);
  }
  const essenciais = palavrasBase.filter(p => !SEO_STOPWORDS.has(seoNormalizar(p)));
  const curta = essenciais.slice(0, 4).join(" ");
  return [
    String(nomeProduto || "").trim().slice(0, 110),
    curta,
    ...qualificadores.map(q => curta + " " + q),
    ...categoria.termos.map(t => curta ? curta + " " + t : t)
  ].filter(Boolean);
}
async function pesquisarPalavrasChaveSEO(nomeProduto) {
  const base = String(nomeProduto || "produto").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 110);
  const categoria = detectarCategoriaSEO(base);
  const locais = termosLocaisSEO(base, categoria);
  const consultas = [base, base + " comprar", base + " como usar"];
  let google = [];
  try {
    const respostas = await Promise.all(consultas.map(async q => {
      const url = "https://suggestqueries.google.com/complete/search?client=firefox&hl=pt-BR&q=" + encodeURIComponent(q);
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ShopeeFilaSEO/2.0)", "Accept-Language": "pt-BR,pt;q=0.9" },
        signal: AbortSignal.timeout(1800)
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (Array.isArray(data?.[1]) ? data[1] : []).map(x => String(x || "").trim()).filter(Boolean);
    }));
    google = respostas.flat();
  } catch (e) {
    console.warn("SEO Google Autocomplete indisponível; usando variações locais por categoria:", e.message);
  }
  const palavrasRelevantes = new Set(seoNormalizar(base).split(" ").filter(p => p.length > 2 && !SEO_STOPWORDS.has(p)));
  const googleRelevante = google.filter(termo => {
    const tokens = seoNormalizar(termo).split(" ").filter(p => p.length > 2);
    const correspondencias = tokens.filter(p => palavrasRelevantes.has(p)).length;
    return correspondencias >= Math.min(2, palavrasRelevantes.size) || seoNormalizar(termo).includes(seoNormalizar(base.slice(0, 35)));
  });
  const vistos = new Set();
  const termos = [...googleRelevante, ...locais].filter(Boolean).filter(termo => {
    const chave = seoNormalizar(termo);
    if (!chave || vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  }).slice(0, 16);
  return {
    termo_principal: base,
    categoria: categoria.nome,
    palavras_chave: termos,
    fonte: googleRelevante.length ? "Google Autocomplete filtrado + sugestões por categoria OpenSEO Lite" : "Sugestões locais por categoria OpenSEO Lite",
    consulta_externa: googleRelevante.length > 0
  };
}

export async function gerarConteudo(p) {
  const seo = await pesquisarPalavrasChaveSEO(p.nome || p.productName);
  const prompt=`Você é especialista em conteúdo para afiliados da Shopee Brasil. Crie um prompt curto e fiel para vídeo vertical 9:16 de 20 a 30 segundos, usando as imagens reais do anúncio como referência principal.

O vídeo deve explicar visualmente o que é o produto, como é usado e quais características comprovadas merecem destaque. O produto deve ser o protagonista. Preserve exatamente modelo, cor, formato, marca, quantidade, embalagem e acessórios confirmados. Não invente materiais, funções, medidas, compatibilidades, resultados ou benefícios. Se faltarem detalhes, apresente visualmente o item sem afirmar o que não está confirmado. Não mencione preço, desconto, vendas, ranking ou popularidade. Não crie roteiro por segundos, storyboard ou falas; deixe a ferramenta de vídeo decidir a montagem. Use português brasileiro e linguagem natural.

Retorne SOMENTE JSON válido com este formato:
{"video_prompt":"prompt de até 850 caracteres","nota":75,"motivo":"avaliação criativa curta","legenda":"legenda para publicar com até 150 caracteres, incluindo hashtags e CTA"}

A nota mede adequação criativa, não prevê visualizações ou vendas. A legenda deve identificar o produto e usar somente informações comprovadas. Não ultrapasse os limites de caracteres.

PALAVRAS-CHAVE SEO (OpenSEO Lite): ${JSON.stringify(seo)}.
Use naturalmente a palavra-chave principal e 2 a 4 termos realmente relevantes na legenda e no prompt. Não force termos que não correspondam ao produto. Não afirme preço, desconto, promoção, material ou benefício que não esteja confirmado.

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
  return {video_prompt,nota,motivo,legenda,seo};
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
const stripTags = (s) => decodeHtml(String(s || "").replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim();

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
    const resposta = await fetch(u.href, { redirect: "follow", signal: AbortSignal.timeout(7000), headers: { "User-Agent": "Mozilla/5.0 ShopeeFilaDirector/1.0" } });
    if (!resposta.ok) throw new Error("Download da imagem retornou HTTP " + resposta.status);
    const hostFinal = new URL(resposta.url || u.href).hostname;
    if (!hostPermitido(hostFinal)) throw new Error("A imagem foi redirecionada para um domínio externo não autorizado.");
    const tipo = String(resposta.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!tipo.startsWith("image/")) throw new Error("O endereço não retornou uma imagem.");
    const tamanho = Number(resposta.headers.get("content-length") || 0);
    if (tamanho > 4 * 1024 * 1024) throw new Error("A imagem excede 5 MB.");
    const bytes = Buffer.from(await resposta.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024) throw new Error("A imagem excede 5 MB.");
    const promptImagem = "Analise visualmente a imagem de anúncio de um produto para um sistema de criação de vídeos comerciais. Retorne SOMENTE JSON válido com: {\"tipo_produto_aparente\":\"...\",\"fatos_visiveis\":[\"...\"],\"cor_aparente\":\"... ou desconhecida\",\"materiais_visiveis\":[\"...\"],\"componentes_visiveis\":[\"...\"],\"uso_que_pode_ser_demonstrado\":[\"...\"],\"lacunas\":[\"...\"],\"alertas_fidelidade\":[\"...\"]}. Descreva somente o que é claramente visível. Não deduza material, tamanho, qualidade, capacidade, função ou benefício apenas pela aparência. Se houver texto na imagem, transcreva somente o que estiver legível e identifique como texto do anúncio, não como verificação independente. Diferencie quantidade de produtos de quantidade de pessoas/modelos: duas modelos ou duas fotos da mesma peça não comprovam que o anúncio vende duas unidades. Não deduza que cores mostradas são variações incluídas no kit sem confirmação textual. Se houver vários itens, diferencie produto principal, variações, acessórios e elementos de cenário. Nunca invente.";
    // O Gemini pode devolver 429/503 temporariamente. Tenta novamente e alterna
    // para o modelo Flash estável antes de desistir da análise visual.
    const modelos = [...new Set([await modeloGeminiDiretor(), "gemini-3-flash-preview"])];
    const erros = [];
    for (const modelo of modelos) {
      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
          const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + modelo + ":generateContent?key=" + process.env.GEMINI_API_KEY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptImagem }, { inlineData: { mimeType: tipo, data: bytes.toString("base64") } }] }],
              generationConfig: { responseMimeType: "application/json", maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } }
            }),
            signal: AbortSignal.timeout(18000)
          });
          const j = await r.json().catch(() => ({}));
          const texto = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("\n");
          if (r.ok && texto) return { status: "analisada", modelo, ...lerJson(texto) };
          const detalhe = "Gemini Vision " + modelo + " HTTP " + r.status + ": " + JSON.stringify(j).slice(0, 300);
          erros.push(detalhe);
          if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(detalhe);
        } catch (e) {
          erros.push(e.message);
          if (!/HTTP (429|500|502|503|504)|timed out|abort/i.test(e.message)) throw e;
        }
        if (tentativa < 2) await new Promise(resolve => setTimeout(resolve, 1200 * tentativa));
      }
    }
    throw new Error(erros.slice(-4).join(" | ") || "Modelos de visão indisponíveis.");
  } catch (e) {
    console.warn("Análise da imagem do Diretor IA:", e.message);
    return { status: "indisponivel", fatos_visiveis: [], lacunas: ["Não foi possível analisar a imagem: " + e.message] };
  }
}

function nomeCurtoFalado(nome) {
  const original = String(nome || "produto").trim();
  const n = original.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\bregata\b/.test(n)) return /\bgola\s+boba\b/.test(n) ? "regata gola boba" : "regata";
  if (/\bmacacao\b/.test(n)) return /\bshort\s+saia\b/.test(n) ? "macacão short saia" : "macacão";
  if (/\bconjunto\b/.test(n)) return /\b(academia|fitness|treino)\b/.test(n) ? "conjunto de academia" : "conjunto";
  if (/\bvestido\b/.test(n)) return "vestido";
  if (/\blegging\b/.test(n)) return "legging";
  if (/\btop\b/.test(n)) return "top";
  if (/\bshort\b/.test(n)) return /\bsaia\b/.test(n) ? "short saia" : "short";
  if (/\bgarrafa\b/.test(n)) return "garrafa";
  if (/\bfone\b/.test(n)) return "fone";
  const ignorar = new Set(["feminino","feminina","masculino","masculina","unissex","tecido","liso","lisa","estampado","estampada","novo","nova","premium","original","adulto","adulta","infantil","kit","com","para","de","da","do","e"]);
  const palavras = original.split(/\s+/).filter(p => !ignorar.has(p.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
  return palavras.slice(0, 3).join(" ") || "produto";
}


export async function pesquisarEstrategia(p) {
  const nome = String(p.nome || p.productName || "produto").slice(0, 250);
  const modeloFlow = String(process.env.FLOW_MODELO || "Omni Flash 1.1").slice(0, 80);
  const limiteInformado = Number(process.env.CLIPE_MAX || DURACAO_PADRAO_DIRETOR);
  const limiteClipe = Number.isFinite(limiteInformado) ? Math.max(1, Math.min(60, limiteInformado)) : DURACAO_PADRAO_DIRETOR;
  if (DURACAO_PADRAO_DIRETOR > limiteClipe) throw new Error("A duração de 10 segundos excede CLIPE_MAX configurado para o Flow.");
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
    caracteristicas: p.caracteristicas || p.features || null,
    preco: p.preco || p.price || p.preco_atual || p.price_current || null,
    preco_original: p.preco_original || p.original_price || p.preco_de || null,
    avaliacao: p.avaliacao || p.rating || null,
    numero_avaliacoes: p.numero_avaliacoes || p.review_count || null
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
  const seo = await pesquisarPalavrasChaveSEO(nome);
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
    "IDIOMA OBRIGATÓRIO: escreva TODOS os campos textuais do JSON em português brasileiro natural. Nunca responda em espanhol, inglês ou mistura de idiomas. Preserve nomes oficiais de produtos e marcas; traduza descrições, justificativas, público, ângulos, ganchos, continuidade, roteiro e lacunas para português brasileiro.",
    "OBJETIVO: criar uma peça curta que prenda atenção, demonstre um benefício real, reduza uma objeção e estimule o clique. Não prometa vendas, viralização ou resultados.",
    "DADOS DO PRODUTO: " + JSON.stringify(dadosProduto),
    "ANÁLISE VISUAL DA IMAGEM (fatos visíveis e lacunas): " + JSON.stringify(analiseImagem),
    "REGRA DE EVIDÊNCIA: características de material, composição, acabamento, caimento, elasticidade, conforto, transparência, durabilidade e benefícios só podem ser afirmadas se estiverem explicitamente descritas nos dados textuais do anúncio ou comprovadas de forma direta. Brilho aparente não comprova tecido acetinado; aparência de caimento não comprova que não aperta ou realça o corpo. Se não houver comprovação, descreva apenas o que se vê, sem transformar aparência em benefício.",
    "REGRA DE QUANTIDADE E VARIAÇÕES: identifique kits e quantidades pelo título/descrição do anúncio. Se houver KIT 2, o vídeo e os argumentos devem representar duas peças. Use a imagem para identificar cores/modelos visíveis, mas não confunda duas modelos, fotos ou poses com duas unidades do produto. Não omita peças incluídas nem acrescente peças/cores não confirmadas.",
    "PÚBLICO: descreva interesses e ocasião de uso prováveis com cautela. Não invente faixa etária precisa, gênero exclusivo ou perfil demográfico sem dados confiáveis.",
    "HISTÓRICO DO PRODUTO: " + historicoTexto,
    "MEMÓRIA DA CATEGORIA " + categoria + ": " + memoriaTexto,
    "FONTES E REFERÊNCIAS PÚBLICAS: " + JSON.stringify(fontes),
    "PALAVRAS-CHAVE SEO (OpenSEO Lite): " + JSON.stringify(seo),
    "Use a palavra-chave principal e 2 a 4 termos SEO relevantes de forma natural na legenda e na estratégia. Ignore sugestões que não descrevam exatamente o produto; não invente atributos nem alegações promocionais.",
    "ETAPA 1 — VERDADE E VALOR DO PRODUTO: separe fatos confirmados no anúncio, fatos visíveis na imagem, opiniões de compradores e lacunas. Use a descrição e as características do anúncio para identificar material/composição, textura, acabamento, caimento, construção, funcionalidades e diferenciais; a imagem sozinha não comprova composição, qualidade, durabilidade ou desempenho. Quando o anúncio informar o tecido/material, explique em linguagem simples por que essa informação importa, sem atribuir propriedades não comprovadas. Use avaliações apenas como percepção de compradores, indicando padrões recorrentes quando houver volume suficiente; nunca transforme opinião em garantia. Analise preço somente se houver preço atual confiável e referência comparável do mesmo produto ou de produtos realmente equivalentes. Só chame de barato, promoção, ótimo preço ou custo-benefício quando a comparação sustentar isso; sem comparação confiável, não faça afirmação de preço. Nunca invente desconto, escassez, material, medidas, funções, certificações, compatibilidade, capacidade, resultados ou acessórios. Alegações promocionais no título (como zero transparência, à prova d'água, antialérgico, compressão ou durabilidade) não são fatos verificados só por aparecerem no anúncio.",
    "ETAPA 2 — ESCOLHA DO ÂNGULO: avalie três ângulos diferentes entre demonstração prática, problema e solução, unboxing, curiosidade, comparação de características, organização/rotina, presente/ocasião, transformação de ambiente ou UGC conversacional. Escolha os três mais adequados ao produto. Dê notas de 0 a 10 para demonstrabilidade, clareza do benefício, novidade frente à memória e risco de afirmação não comprovada. Escolha um ângulo e explique por que venceu. Penalize repetir ângulos e ganchos recentes da categoria, principalmente os rejeitados.",
    "ETAPA 3 — ROTEIRO OBRIGATÓRIO: a fala precisa dizer claramente o NOME DO PRODUTO (use uma versão curta, mas reconhecível, do nome exato do anúncio) e apresentar PELO MENOS DOIS benefícios ou características úteis, reais e confirmados nos dados do anúncio ou claramente visíveis. Não basta dizer apenas 'olha esse produto', 'confira este item' ou mostrar o produto sem identificá-lo. Estruture a fala em português brasileiro: nome do produto + dois benefícios/características confirmados + CTA. Exemplo de estrutura, não copie literalmente: 'Essa [nome do produto] tem [característica/benefício 1] e [característica/benefício 2]. Clique e confira!'. Se não houver dois benefícios comprováveis, cite duas características objetivas confirmadas, sem inventar vantagens. Comece com o produto visível nos primeiros 2 segundos, demonstre ao menos uma característica real em ação quando for possível e seguro. A fala deve soar espontânea, específica e caber naturalmente em 10 segundos; use um nome curto de 2 a 4 palavras, nunca leia o título completo do anúncio. Não simule depoimento ou experiência pessoal que não aconteceu.",
    "ETAPA 2A — TRÊS GANCHOS PARA TESTE: produza EXATAMENTE três aberturas realmente diferentes, uma de problema e solução, uma de curiosidade e uma de demonstração visual. Cada uma deve ter uma frase curta (máximo 12 palavras) e uma abertura visual executável nos primeiros 2 segundos. Não repita a mesma frase trocando poucas palavras. Não invente características, não use preço, desconto, escassez, número de vendas ou promessas. Retorne em ganchos: [{tipo:'Problema e solução',texto:'...',abertura_visual:'...'},{tipo:'Curiosidade',texto:'...',abertura_visual:'...'},{tipo:'Demonstração',texto:'...',abertura_visual:'...'}]. O vídeo principal continua com 10 segundos; os três ganchos são alternativas de abertura, não três chamadas de IA nem três vídeos completos.",
    "ETAPA 2B — PALAVRA-CHAVE E LEGENDA: escolha uma palavra-chave curta usando somente termos do nome e dos dados confirmados do produto. Gere uma legenda pronta para publicação com no máximo 150 caracteres, incluindo 3 a 5 hashtags específicas. Não inclua preço, valores, desconto, promoção, quantidade de vendas, ranking, avaliações ou promessas absolutas. A legenda deve identificar o produto e convidar a conferir o link.",
    "ETAPA 3A — RETENÇÃO E LIMITES: produto claramente visível desde o primeiro segundo; uma mensagem principal; uma demonstração simples e real; nada de introdução longa. A fala total tem no máximo 22 palavras e deve caber em 10 segundos em ritmo natural. Cada cena/trecho descrito deve conter apenas fatos confirmados. Mantenha exatamente a mesma pessoa, roupa, cenário, iluminação e identidade visual durante todo o vídeo.",
    "MODELO DE GERAÇÃO CONFIGURADO: " + modeloFlow + ". Duração solicitada: 10 segundos; limite máximo configurado: " + limiteClipe + " segundos. Não altere a duração solicitada.",
    "ETAPA 4 — VÍDEO ÚNICO PARA GOOGLE FLOW: retorne apenas UM vídeo, UM clipe e UM prompt_flow, com duração EXATA de 10 segundos, formato vertical 9:16. Não divida em cenas ou partes. Use 0–2s para gancho visual com produto visível; 2–7s para apresentar uma característica confirmada; 7–10s para recomendação e CTA. Tudo em uma única tomada contínua. Escolha o melhor meio de apresentação. A fala deve ser natural, em português brasileiro, usar nome curto de 2 a 4 palavras (nunca o título completo) e caber em 10 segundos sem acelerar. O prompt_flow deve ser completo e pronto para colar no Flow, contendo produto, cenário, apresentador quando adequado, ação contínua, câmera, luz, fala, texto, áudio e restrições de fidelidade. Sem cortes ou transições.",
    "ETAPA 4A — SE FOR ROUPA OU MODA FITNESS: a pessoa deve vestir exatamente a peça anunciada, sem adicionar roupa por cima nem alterar cor, corte ou modelo. Em 10 segundos, use ações simples e realistas para apresentar a peça. Não tente provar ausência de transparência com a mão, alongamento, agachamento ou teste visual; não afirme que o tecido não fica transparente. Só demonstre detalhes visíveis/confirmados. Nunca levantar, puxar ou expor a roupa. A fala deve usar nome curto e destacar somente elementos confirmados.",
    "CONTINUIDADE: crie um bloco compacto com identidade visual da pessoa (se houver), roupa igual à referência, cenário, iluminação e câmera. Como existe apenas um vídeo contínuo, não descreva vários clipes nem repita instruções por clipe. Se uma pessoa não acrescentar valor, escolha mãos, demonstração ou produto em destaque.",
    "FIDELIDADE VISUAL: a imagem do anúncio é referência prioritária. Preserve forma, cor, proporções, estampa, marca, embalagem, componentes e quantidade visíveis. Não acrescente acessórios nem invente detalhes. Evite alterações de design, mãos deformadas, contato impossível, movimentos bruscos ou transições que escondam o item. Para roupas, não crie camadas de roupa que escondam a peça anunciada.",
    "PROMPT FINAL: prompt_video deve conter um único prompt pronto para copiar, em formato 9:16 e duração exata de 10 segundos. A fala deve ser audível, sincronizada e em português brasileiro, usar nome curto de 2 a 4 palavras (nunca o título completo do anúncio), mencionar uma ou duas características reais confirmadas e terminar com CTA. Use até 22 palavras, sem acelerar. Nunca transforme alegação promocional do título em fato comprovado. Não invente teste, resultado ou experiência pessoal. O prompt deve conter produto, apresentação, cenário, ação contínua, câmera, luz, fala, texto e áudio.",
    "VALIDAÇÃO: retorne exatamente um clipe com duracao_segundos igual a 10 e apenas um prompt_flow. O vídeo deve ser contínuo, sem cortes, e conter gancho, apresentação e CTA dentro dos mesmos 10 segundos. A fala deve usar nome curto e caber no tempo. Nenhuma afirmação pode exceder os dados ou o que está visível. Nota 0–100 mede adequação criativa estimada, não conversão.",
    "RETORNE SOMENTE JSON válido, sem markdown, com este formato: " +
    JSON.stringify({
      categoria: categoria,
      publico_alvo: "perfil provável, sem estereótipos",
      beneficio_principal: "benefício demonstrável",
      argumentos_venda: ["argumento comercial confirmado 1", "argumento comercial confirmado 2"],
      analise_preco: "avaliação fundamentada do preço ou ausência de comparação confiável",
      angulos_avaliados: [{ angulo: "nome", demonstrabilidade: 0, clareza_beneficio: 0, novidade: 0, risco_fidelidade: 0, motivo: "..." }],
      angulo_escolhido: "...",
      formato_escolhido: "...",
      nota_adequacao: 0,
      justificativa: "...",
      gancho: "...",
      ganchos: [{ tipo: "Problema e solução", texto: "...", abertura_visual: "..." }, { tipo: "Curiosidade", texto: "...", abertura_visual: "..." }, { tipo: "Demonstração", texto: "...", abertura_visual: "..." }],
      palavra_chave: "...",
      legenda: "... com 3 a 5 hashtags e até 150 caracteres",
      hashtags: ["#...", "#...", "#..."],
      duracao_segundos: 10,
      continuidade: { pessoa: "... ou sem pessoa", roupa: "...", cenario: "...", iluminacao: "...", camera: "..." },
      clipes: [{ numero: 1, duracao_segundos: 10, objetivo: "apresentar e vender em um único vídeo", visual: "...", acao: "...", camera: "...", fala: "...", texto_tela: "...", prompt_flow: "um único prompt completo para vídeo contínuo de 10 segundos" }],
      estrutura_cenas: [{ momento: "0–10s", visual: "...", objetivo: "...", camera: "...", acao: "..." }],
      narracao: "...",
      textos_tela: ["..."],
      cta: "...",
      prompt_video: "um único prompt completo pronto para copiar para vídeo de 10 segundos",
      alertas: ["..."],
      fontes_utilizadas: [{ titulo: "...", url: "...", contribuicao: "..." }],
      limites_pesquisa: "..."
    }) + ". Todos os campos devem conter dados reais da análise; não mantenha exemplos genéricos do esquema."
  ].join("\n\n");

  const quantidadeKit = extrairQuantidadeKit(nome, dadosProduto.descricao, dadosProduto.caracteristicas, dadosProduto.variacao);
  const contextoQuantidade = quantidadeKit
    ? "O título/descrição declara KIT com " + quantidadeKit + " peças. A estratégia e o prompt devem mostrar exatamente " + quantidadeKit + " peças, sem confundir modelos ou fotos com unidades."
    : "A quantidade de peças não está confirmada; não invente kit, quantidade nem variações incluídas.";
  const resultado = await iaJsonDiretor(prompt + "\n\nQUANTIDADE DO ANÚNCIO: " + contextoQuantidade, nome, { quantidadeKit });
  const clipes = resultado.clipes.map((c, i) => ({
    ...c,
    numero: Number(c.numero || i + 1),
    duracao_segundos: Number(c.duracao_segundos),
    prompt_flow: String(c.prompt_flow || "").trim().replace(/\\\\n/g, "\\n")
  }));
  const duracao = clipes.reduce((s, c) => s + c.duracao_segundos, 0);
  if (clipes.length !== 1 || duracao !== DURACAO_PADRAO_DIRETOR || Number(resultado.duracao_segundos) !== DURACAO_PADRAO_DIRETOR || clipes.some(c => c.duracao_segundos !== DURACAO_PADRAO_DIRETOR || !c.prompt_flow)) {
    throw new Error("A estratégia retornada não passou na validação dos clipes. Gere novamente.");
  }
  if (duracao !== DURACAO_PADRAO_DIRETOR) throw new Error("O vídeo precisa ter exatamente 10 segundos.");
  let promptVideo = String(resultado.prompt_video || "").trim().slice(0, 12000);
  if (!resultado.formato_escolhido || !promptVideo) throw new Error("A IA não retornou uma estratégia completa.");
  const ganchos = validarGanchos(resultado.ganchos, nome);
  const palavraChave = palavraChaveProduto(nome);
  const hashtagsEntrada = Array.isArray(resultado.hashtags) ? resultado.hashtags : [];
  const hashtags = [...new Set(hashtagsEntrada.map(x => {
    const t = String(x || "").replace(/[^#\p{L}\p{N}_]/gu, "").slice(0, 25);
    return t.startsWith("#") ? t : "#" + t;
  }).filter(x => /^#[\p{L}\p{N}_]{2,}$/u.test(x) && !/promo|desconto|oferta|venda|viral|ranking|avaliacao|preco|barato|comprador/i.test(normalizarTexto(x))))].slice(0, 3);
  const termosTag = palavraChave.split(/\s+/).filter(Boolean);
  const tagsBase = [
    "#" + (termosTag[0] || "produto").replace(/[^\p{L}\p{N}]/gu, ""),
    "#" + ((termosTag[0] || "produto") + "Shopee").replace(/[^\p{L}\p{N}]/gu, ""),
    "#AchadinhosShopee"
  ];
  for (const tag of tagsBase) if (hashtags.length < 3 && !hashtags.some(x => normalizarTexto(x) === normalizarTexto(tag))) hashtags.push(tag);
  const corpoLegenda = legendaSegura(resultado.legenda || (palavraChave + ". Confira no link!"));
  const tagsFinal = hashtags.slice(0, 3);
  const textoTags = tagsFinal.join(" ");
  const limiteCorpo = Math.max(0, 149 - textoTags.length);
  const semTags = corpoLegenda.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
  const corpoCurto = semTags.length > limiteCorpo
    ? semTags.slice(0, limiteCorpo).replace(/\s+\S*$/, "").trim()
    : semTags;
  const legenda = (corpoCurto + " " + textoTags).trim();
  const quantidadeHashtags = (legenda.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (!legenda || legenda.length > 150 || palavras(legenda).length > 35 || quantidadeHashtags < 3) {
    throw new Error("A legenda não passou na validação de até 150 caracteres e 3 hashtags.");
  }
  const falaValidada = String(clipes[0].fala || "");
  if (palavras(falaValidada).length > LIMITE_FALA_DIRETOR) throw new Error("A fala ultrapassou 22 palavras; gere novamente.");
  const continuidadeValidada = validarContinuidade(resultado.continuidade);
  const estrategia = {
    ...resultado,
    ganchos,
    palavra_chave: palavraChave,
    legenda,
    hashtags,
    continuidade: continuidadeValidada,
    modelo_flow: modeloFlow,
    limite_clipe_segundos: limiteClipe,
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