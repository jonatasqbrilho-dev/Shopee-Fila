import { db, json, autorizado, shopee, gerarConteudo } from "../lib.js";

const escGql=s=>String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"');
const platformSub=(p,k)=>`${k}_${String(p.item_id).slice(-12)}`;

async function gerarLinks(p){
  const out={};
  for(const k of ["tiktok","youtube","instagram","telegram"]){
    const q=`mutation { generateShortLink(input:{originUrl:"${escGql(p.link_produto||p.link_afiliado)}",subIds:["${escGql(k)}","${escGql(platformSub(p,k))}"]}) { shortLink } }`;
    try{out[k]=(await shopee(q)).generateShortLink.shortLink;}catch(e){out[k]=null;}
  }
  return out;
}

async function sincronizarConversoes(sb){
  const end=Math.floor(Date.now()/1000), start=end-30*24*60*60;
  const q=`{ conversionReport(purchaseTimeStart:${start},purchaseTimeEnd:${end},limit:500) { nodes { clickTime purchaseTime conversionId totalCommission netCommission utmContent orders { orderId orderStatus items { itemId itemName itemPrice qty itemTotalCommission attributionType } } } pageInfo { hasNextPage scrollId } } }`;
  const d=await shopee(q), nodes=d.conversionReport?.nodes||[];
  const byItem=new Map();
  for(const n of nodes){
    const orders=n.orders||[];
    for(const o of orders){
      for(const it of (o.items||[])){
        const id=String(it.itemId), x=byItem.get(id)||{cliques:0,pedidos:new Set(),itens:0,vendas:0,estimada:0};
        if(n.clickTime)x.cliques++;
        x.pedidos.add(String(o.orderId)); x.itens+=Number(it.qty||0); x.vendas+=Number(it.itemPrice||0)*Number(it.qty||0); x.estimada+=Number(it.itemTotalCommission||0); byItem.set(id,x);
      }
    }
  }
  let atualizados=0;
  for(const [item_id,x] of byItem){
    const pedidos=x.pedidos.size, conversao=x.cliques?Number((pedidos/x.cliques*100).toFixed(2)):0;
    const {error}=await sb.from("produtos").update({cliques_convertidos:x.cliques,pedidos,itens_vendidos:x.itens,valor_pedidos:Number(x.vendas.toFixed(2)),comissao_estimada:Number(x.estimada.toFixed(2)),conversao,ultima_sincronizacao:new Date().toISOString(),metricas_status:"conversionReport sincronizado (30 dias)",atualizado_em:new Date().toISOString()}).eq("item_id",item_id);
    if(!error)atualizados++;
  }
  return {conversoes:nodes.length,produtos_atualizados:atualizados,janela_dias:30,aviso:"A API de conversionReport informa cliques associados a conversões; o total bruto de cliques do relatório de cliques da Shopee não é exposto por este endpoint."};
}

export default async(req)=>{
  const sb=db(),url=new URL(req.url);
  if(req.method==="GET"&&url.searchParams.get("publico")){const {data}=await sb.from("produtos").select("nome,imagem,link_afiliado,legenda,hashtags").eq("status","publicado").order("atualizado_em",{ascending:false}).limit(60);return json(data||[]);}
  if(!autorizado(req))return json({erro:"Senha incorreta"},401);
  if(req.method==="GET"){
    if(url.searchParams.get("campos")){try{const d=await shopee(`{ __type(name: "ProductOfferV2") { fields { name } } }`),campos=d.__type.fields.map(f=>f.name);return json({campos,video:campos.filter(c=>/video|media/i.test(c)),imagens:campos.filter(c=>/image|img|pic|photo/i.test(c))});}catch(e){return json({erro:e.message},500)}}
    if(url.searchParams.get("resumo")){const {data,error}=await sb.from("produtos").select("status,pedidos,itens_vendidos,valor_pedidos,comissao_estimada,comissao_validada,cliques_convertidos");if(error)return json({erro:error.message},500);const r=(data||[]).reduce((a,p)=>{a.produtos++;a.pedidos+=Number(p.pedidos||0);a.itens+=Number(p.itens_vendidos||0);a.vendas+=Number(p.valor_pedidos||0);a.estimada+=Number(p.comissao_estimada||0);a.validada+=Number(p.comissao_validada||0);a.cliques+=Number(p.cliques_convertidos||0);a.status[p.status]=(a.status[p.status]||0)+1;return a},{produtos:0,pedidos:0,itens:0,vendas:0,estimada:0,validada:0,cliques:0,status:{}});return json(r)}
    const {data,error}=await sb.from("produtos").select("*").eq("status",url.searchParams.get("status")||"pendente").order("nota",{ascending:false}).limit(100);return error?json({erro:error.message},500):json(data||[]);
  }
  const b=await req.json();
  if(b.acao==="gerar_conteudo"){const {data:p,error}=await sb.from("produtos").select("*").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado"},404);try{const c=await gerarConteudo(p);const {error:e}=await sb.from("produtos").update({...c,video_textos:c.video_textos.join("\n"),pacote_gerado_em:new Date().toISOString(),atualizado_em:new Date().toISOString()}).eq("id",b.id);return e?json({erro:e.message},500):json({ok:true,conteudo:c});}catch(e){return json({erro:e.message},500)}}
  if(b.acao==="gerar_links"){const {data:p,error}=await sb.from("produtos").select("*").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado"},404);const links=await gerarLinks(p);const {error:e}=await sb.from("produtos").update({links_plataforma:links,sub_ids:["tiktok","youtube","instagram","telegram"],atualizado_em:new Date().toISOString()}).eq("id",b.id);return e?json({erro:e.message},500):json({ok:true,links});}
  if(b.acao==="sincronizar_metricas"){try{return json({ok:true,...await sincronizarConversoes(sb)});}catch(e){return json({erro:e.message},500)}}
  if(b.acao==="upload_url"){const path=`${b.id}-${Date.now()}.${String(b.ext||"mp4").replace(/\W/g,"")}`,r=await sb.storage.from("videos").createSignedUploadUrl(path);if(r.error)return json({erro:r.error.message},500);return json({url:r.data.signedUrl,publico:sb.storage.from("videos").getPublicUrl(path).data.publicUrl});}
  const upd={atualizado_em:new Date().toISOString()};let aviso="";
  if(b.acao==="rejeitar")upd.status="rejeitado";else if(b.acao==="sem_video")upd.status="sem_video";else if(b.acao==="publicado")upd.status="publicado";else if(b.acao==="aprovar")Object.assign(upd,{status:"aprovado",legenda:b.legenda,plataformas:b.plataformas||[],video_url:b.video_url});else return json({erro:"Ação inválida"},400);
  const {error}=await sb.from("produtos").update(upd).eq("id",b.id);return error?json({erro:error.message},500):json({ok:true,aviso});
};
