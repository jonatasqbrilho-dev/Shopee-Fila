import { db, json, autorizado } from "../lib.js";

const norm = s => String(s || "").toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const clean = (s, max = 300) => String(s || "").replace(/[<>]/g, "").trim().slice(0, max);
const decode = s => String(s || "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x2F;/g,"/");
const strip = s => decode(String(s || "").replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim();
const clamp = (n,min,max) => Math.min(max,Math.max(min,Number(n)||0));

const SEO_GROUPS = [
  {name:"Moda e roupas",test:/\b(calca|pantalona|blusa|camisa|camiseta|vestido|saia|short|bermuda|legging|sutia|calcinha|cueca|jaqueta|macacao|conjunto|roupa|moda|fitness)\b/,terms:["como combinar","ideias de look","moda feminina","para o dia a dia","estilo casual"]},
  {name:"Calçados",test:/\b(tenis|sapato|sandalia|chinelo|bota|sapatilha|scarpin|rasteira)\b/,terms:["como combinar","looks com","como escolher tamanho","para o dia a dia"]},
  {name:"Beleza",test:/\b(maquiagem|batom|rimel|perfume|hidratante|shampoo|condicionador|creme|serum|protetor solar|cabelo|skincare)\b/,terms:["como usar","cuidados pessoais","rotina de beleza","para que serve"]},
  {name:"Eletrônicos",test:/\b(fone|headphone|bluetooth|celular|smartphone|carregador|cabo usb|teclado|mouse|monitor|notebook|tablet|smartwatch|camera|microfone)\b/,terms:["como funciona","compatibilidade","como conectar","funções e recursos"]},
  {name:"Casa e organização",test:/\b(organizador|prateleira|armario|cabide|cesto|caixa organizadora|decoracao|tapete|cortina|almofada|luminaria|lampada|vaso|movel)\b/,terms:["organização da casa","como organizar","utilidades domésticas","dicas de organização"]},
  {name:"Cozinha",test:/\b(cozinha|panela|frigideira|air fryer|fritadeira|liquidificador|processador|garrafa|termica|pote|forma|assadeira|talher|utensilio|cafeteira|marmita)\b/,terms:["utilidades para cozinha","organização da cozinha","utensílios domésticos","como usar"]},
  {name:"Pet",test:/\b(pet|cachorro|cao|gato|coleira|brinquedo pet|cama pet|comedouro|bebedouro|racao)\b/,terms:["acessórios para pets","cuidados com cães","cuidados com gatos","como escolher"]},
  {name:"Infantil",test:/\b(bebe|infantil|crianca|mamadeira|fralda|carrinho|berco|brinquedo infantil|lancheira)\b/,terms:["produtos infantis","uso infantil","como escolher","cuidados no dia a dia"]},
  {name:"Fitness",test:/\b(academia|fitness|musculacao|halter|anilha|colchonete|yoga|corrida|bicicleta)\b/,terms:["acessórios para treino","treino em casa","atividade física","rotina fitness"]}
];

async function pesquisarSEO(term) {
  const base = clean(term,110);
  if (!base) throw new Error("Informe um produto ou palavra-chave.");
  const category = SEO_GROUPS.find(x => x.test.test(norm(base))) || {name:"Produto geral",terms:["como usar","características","para que serve","avaliação","vale a pena"]};
  const stop = new Set(["a","o","as","os","de","da","do","das","dos","com","sem","para","por","na","no","nas","nos","e","em","um","uma","kit"]);
  const tokens = base.split(/\s+/).filter(x => !stop.has(norm(x)));
  const short = tokens.slice(0,4).join(" ");
  const local = [base,short,...category.terms.map(t => short ? short+" "+t : t)].filter(Boolean);
  const queries = [base,base+" comprar",base+" como usar"];
  const responses = await Promise.all(queries.map(async q => {
    try {
      const r = await fetch("https://suggestqueries.google.com/complete/search?client=firefox&hl=pt-BR&q="+encodeURIComponent(q),{headers:{"User-Agent":"Mozilla/5.0 (compatible; ShopeeFilaSEO/2.0)","Accept-Language":"pt-BR,pt;q=0.9"},signal:AbortSignal.timeout(2500)});
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data?.[1]) ? data[1].map(x=>String(x||"").trim()).filter(Boolean) : [];
    } catch { return []; }
  }));
  const google = responses.flat();
  const relevant = google.filter(x => {
    const t = norm(x).split(" ").filter(w=>w.length>2);
    const baseWords = norm(base).split(" ").filter(w=>w.length>2);
    return t.some(w=>baseWords.includes(w));
  });
  const seen = new Set();
  const keywords = [...relevant,...local].filter(x => {
    const k=norm(x); if(!k||seen.has(k)) return false; seen.add(k); return true;
  }).slice(0,25);
  return {term:base,category:category.name,keywords,source:relevant.length?"Google Autocomplete + sugestões locais":"Sugestões locais gratuitas",google_suggestions:relevant.length,checked_at:new Date().toISOString()};
}

async function pesquisarConcorrentes(term) {
  const query = clean(term,180);
  if (!query) throw new Error("Informe o produto para pesquisar concorrentes.");
  const searches = ['"'+query+'" preço loja Brasil','"'+query+'" Shopee produto','"'+query+'" comprar avaliação'];
  const all = await Promise.all(searches.map(async q => {
    try {
      const r=await fetch("https://html.duckduckgo.com/html/?q="+encodeURIComponent(q),{headers:{"User-Agent":"Mozilla/5.0 (compatible; ShopeeFilaResearch/1.0)","Accept-Language":"pt-BR,pt;q=0.9"},signal:AbortSignal.timeout(5000)});
      if(!r.ok) return [];
      const html=await r.text();
      return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(m=>/result__a/.test(m[1])).map(m=>{
        let href=decode(m[1].match(/href=["']([^"']+)["']/i)?.[1]||"");
        if(href.startsWith("//")) href="https:"+href;
        try {const u=new URL(href);const real=u.searchParams.get("uddg");if(real)href=real;}catch{}
        const after=html.slice((m.index||0)+m[0].length,(m.index||0)+m[0].length+1800);
        const snippet=after.match(/result__snippet[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]||"";
        return {title:strip(m[2]),url:href,snippet:strip(snippet),query:q};
      }).filter(x=>x.title&&/^https?:\/\//i.test(x.url));
    } catch { return []; }
  }));
  const seen=new Set();
  return all.flat().filter(x=>{if(seen.has(x.url))return false;seen.add(x.url);return true;}).slice(0,18);
}

function makeTrendRanking(products,snapshots) {
  const grouped=new Map();
  for(const s of snapshots||[]) {
    if(!s.product_id) continue;
    const a=grouped.get(s.product_id)||[];
    a.push(s);grouped.set(s.product_id,a);
  }
  const enriched=(products||[]).map(p=>{
    const history=(grouped.get(p.id)||[]).sort((a,b)=>new Date(a.captured_at)-new Date(b.captured_at));
    const first=history[0],last=history[history.length-1];
    const delta=history.length>1?Math.max(0,Number(last.sales||0)-Number(first.sales||0)):0;
    const hours=history.length>1?Math.max(1,(new Date(last.captured_at)-new Date(first.captured_at))/3600000):0;
    const velocity=hours?delta*24/hours:0;
    return {...p,sales_delta:delta,sales_per_day:Number(velocity.toFixed(2)),snapshot_count:history.length,trend_confirmed:history.length>1,trend_state:history.length<2?"Em observação":delta>0?"Crescendo":"Estável"};
  });
  const maxSales=Math.max(1,...enriched.map(x=>Math.log1p(Number(x.vendas||0))));
  const maxVelocity=Math.max(1,...enriched.map(x=>Math.log1p(x.sales_per_day)));
  const maxCommission=Math.max(0.01,...enriched.map(x=>Number(x.comissao||0)));
  return enriched.map(p=>{
    const salesScore=Math.log1p(Number(p.vendas||0))/maxSales;
    const velocityScore=Math.log1p(p.sales_per_day)/maxVelocity;
    const commissionScore=clamp(Number(p.comissao||0)/maxCommission,0,1);
    const ratingScore=clamp(Number(p.avaliacao||0)/5,0,1);
    const discountScore=clamp(Number(p.desconto||0)/100,0,1);
    const score=Math.round((velocityScore*35+salesScore*25+commissionScore*20+ratingScore*15+discountScore*5)*100)/100;
    return {...p,potential_score:score};
  }).sort((a,b)=>b.potential_score-a.potential_score);
}

async function dashboard(sb,url) {
  const start=(url.searchParams.get("inicio")||new Date(Date.now()-30*86400000).toISOString().slice(0,10))+"T00:00:00.000Z";
  const end=(url.searchParams.get("fim")||new Date().toISOString().slice(0,10))+"T23:59:59.999Z";
  const [pr,ps,ms,mem,tests,keywords,competitors,queue]=await Promise.all([
    sb.from("produtos").select("id,item_id,nome,imagem,preco,desconto,vendas,avaliacao,comissao,nota,status,atualizado_em,cliques_convertidos,pedidos,itens_vendidos,valor_pedidos,comissao_estimada,comissao_validada,conversao").order("vendas",{ascending:false}).limit(1000),
    sb.from("shopee_product_snapshots").select("product_id,sales,price,discount,rating,commission,captured_at").gte("captured_at",new Date(Date.now()-90*86400000).toISOString()).lte("captured_at",end).order("captured_at",{ascending:true}).limit(10000),
    sb.from("shopee_metrics_snapshots").select("product_id,item_id,product_name,clicks,orders,items_sold,order_value,estimated_commission,validated_commission,conversion,captured_at").gte("captured_at",new Date(new Date(start).getTime()-86400000).toISOString()).lte("captured_at",end).order("captured_at",{ascending:true}).limit(10000),
    sb.from("diretor_ia_memoria").select("id,produto_id,produto_nome,categoria,formato_escolhido,angulo_escolhido,gancho,estrategia,feedback,criado_em").order("criado_em",{ascending:false}).limit(60),
    sb.from("shopee_hook_tests").select("*").order("created_at",{ascending:false}).limit(100),
    sb.from("shopee_keyword_history").select("*").order("created_at",{ascending:false}).limit(40),
    sb.from("shopee_competitor_research").select("*").order("created_at",{ascending:false}).limit(20),
    sb.from("shopee_video_queue").select("*").gte("scheduled_date",start.slice(0,10)).lte("scheduled_date",end.slice(0,10)).order("scheduled_date").order("position").limit(500)
  ]);
  for(const [label,r] of [["produtos",pr],["snapshots",ps],["métricas",ms],["memória",mem],["testes",tests],["SEO",keywords],["concorrentes",competitors],["fila",queue]]) if(r.error) throw new Error("Falha ao carregar "+label+": "+r.error.message);
  const products=pr.data||[];
  const trend=makeTrendRanking(products,ps.data||[]);
  const byId=new Map(products.map(p=>[p.id,p]));
  const metricGroups=new Map();
  for(const s of ms.data||[]) {const a=metricGroups.get(s.product_id)||[];a.push(s);metricGroups.set(s.product_id,a);}
  const report=[...metricGroups.entries()].map(([id,arr])=>{
    arr.sort((a,b)=>new Date(a.captured_at)-new Date(b.captured_at));
    const first=arr[0],last=arr[arr.length-1],p=byId.get(id)||{};
    const delta=field=>Math.max(0,Number(last[field]||0)-Number(first[field]||0));
    return {product_id:id,name:last.product_name||p.nome||"Produto",image:p.imagem||null,clicks:delta("clicks"),orders:delta("orders"),items_sold:delta("items_sold"),order_value:delta("order_value"),estimated_commission:delta("estimated_commission"),validated_commission:delta("validated_commission"),conversion:last.conversion||0,snapshots:arr.length,period_start:first.captured_at,period_end:last.captured_at};
  }).sort((a,b)=>b.estimated_commission-a.estimated_commission);
  const totals=report.reduce((a,x)=>{for(const k of ["clicks","orders","items_sold","order_value","estimated_commission","validated_commission"])a[k]+=Number(x[k]||0);return a;},{clicks:0,orders:0,items_sold:0,order_value:0,estimated_commission:0,validated_commission:0});
  return json({ok:true,period:{start,end},products,trend:trend.slice(0,100),snapshots:ps.data||[],report,totals,memories:mem.data||[],hook_tests:tests.data||[],keywords:keywords.data||[],competitors:competitors.data||[],queue:queue.data||[],notes:{trend:"Pontuação de potencial, não garantia de vendas. Crescimento real só fica confirmado após pelo menos duas medições.",reports:"Relatórios por período começam a acumular histórico a partir da ativação desta central."}});
}

export default async req => {
  if(!autorizado(req)) return json({erro:"Senha incorreta"},401);
  const sb=db(),url=new URL(req.url);
  if(req.method==="GET") {
    const action=url.searchParams.get("acao")||"painel";
    if(action==="painel") {try{return await dashboard(sb,url);}catch(e){return json({erro:e.message},500);}}
    if(action==="seo") {const {data,error}=await sb.from("shopee_keyword_history").select("*").order("created_at",{ascending:false}).limit(100);return error?json({erro:error.message},500):json({ok:true,items:data||[]});}
    return json({erro:"Ação GET inválida."},400);
  }
  if(req.method!=="POST") return json({erro:"Método não permitido."},405);
  const body=await req.json().catch(()=>null);
  if(!body||typeof body!=="object"||Array.isArray(body))return json({erro:"JSON inválido."},400);
  try {
    if(body.acao==="pesquisar_seo") {
      const seo=await pesquisarSEO(body.term);
      const {data,error}=await sb.from("shopee_keyword_history").insert({product_id:body.product_id||null,term:seo.term,category:seo.category,keywords:seo.keywords,source:seo.source}).select("*").single();
      if(error)throw new Error(error.message);
      return json({ok:true,seo,record:data});
    }
    if(body.acao==="pesquisar_concorrentes") {
      const productName=clean(body.product_name,180);
      const results=await pesquisarConcorrentes(productName);
      const {data,error}=await sb.from("shopee_competitor_research").insert({product_id:body.product_id||null,product_name:productName,search_query:productName,results}).select("*").single();
      if(error)throw new Error(error.message);
      return json({ok:true,research:data});
    }
    if(body.acao==="adicionar_oferta") {
      const id=clean(body.research_id,80),offer=body.offer||{};
      const name=clean(offer.name,160),urlValue=clean(offer.url,1000),seller=clean(offer.seller,120),price=Number(offer.price);
      if(!id||!name||!Number.isFinite(price)||price<=0)throw new Error("Informe nome e preço válido da oferta concorrente.");
      if(urlValue&&!/^https:\/\//i.test(urlValue))throw new Error("O link da oferta precisa usar HTTPS.");
      const {data:row,error:readError}=await sb.from("shopee_competitor_research").select("offers").eq("id",id).single();
      if(readError||!row)throw new Error(readError?.message||"Pesquisa não encontrada.");
      const offers=Array.isArray(row.offers)?row.offers:[];
      offers.push({name,seller,price,url:urlValue,observed_at:new Date().toISOString()});
      const {error}=await sb.from("shopee_competitor_research").update({offers}).eq("id",id);
      if(error)throw new Error(error.message);
      return json({ok:true,offers});
    }
    if(body.acao==="criar_teste_gancho") {
      const memoryId=Number(body.memory_id),index=Number(body.hook_index);
      const {data:memory,error}=await sb.from("diretor_ia_memoria").select("id,produto_id,estrategia,produto_nome").eq("id",memoryId).single();
      if(error||!memory)throw new Error(error?.message||"Análise do Diretor IA não encontrada.");
      const hooks=Array.isArray(memory.estrategia?.ganchos)?memory.estrategia.ganchos:[];
      const hook=hooks[index];
      if(!hook?.texto)throw new Error("Gancho não encontrado nessa análise.");
      const {data,error:insertError}=await sb.from("shopee_hook_tests").insert({product_id:memory.produto_id,memory_id:memory.id,hook_type:clean(hook.tipo,80)||"Gancho",hook_text:clean(hook.texto,500),visual_open:clean(hook.abertura_visual,700)}).select("*").single();
      if(insertError)throw new Error(insertError.message);
      return json({ok:true,test:data});
    }
    if(body.acao==="atualizar_teste_gancho") {
      const id=clean(body.id,80),status=["planejado","publicado","descartado"].includes(body.status)?body.status:undefined;
      const patch={updated_at:new Date().toISOString()};
      if(status)patch.status=status;
      for(const k of ["impressions","views","clicks","orders"])if(body[k]!==undefined)patch[k]=Math.round(clamp(body[k],0,100000000));
      if(body.revenue!==undefined)patch.revenue=Number(clamp(body.revenue,0,1000000000).toFixed(2));
      if(body.notes!==undefined)patch.notes=clean(body.notes,1000)||null;
      const {data,error}=await sb.from("shopee_hook_tests").update(patch).eq("id",id).select("*").single();
      if(error)throw new Error(error.message);
      return json({ok:true,test:data});
    }
    if(body.acao==="avaliar_memoria") {
      const feedback=["aprovado","rejeitado","sem_avaliacao"].includes(body.feedback)?body.feedback:null;
      if(!feedback)throw new Error("Avaliação inválida.");
      const {error}=await sb.from("diretor_ia_memoria").update({feedback,observacao:clean(body.observacao,500)||null,avaliado_em:new Date().toISOString()}).eq("id",Number(body.memory_id));
      if(error)throw new Error(error.message);
      return json({ok:true});
    }
    return json({erro:"Ação POST inválida."},400);
  } catch(e) {return json({erro:e.message||"Falha ao processar solicitação."},400);}
};
