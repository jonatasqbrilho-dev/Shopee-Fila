import { db, json, autorizado, shopee, gerarConteudo } from "../lib.js";

export default async (req) => {
  const sb=db(), url=new URL(req.url);
  if(req.method==="GET"&&url.searchParams.get("publico")){
    const {data}=await sb.from("produtos").select("nome,imagem,link_afiliado,legenda,hashtags").eq("status","publicado").order("atualizado_em",{ascending:false}).limit(60);
    return json(data||[]);
  }
  if(!autorizado(req)) return json({erro:"Senha incorreta"},401);
  if(req.method==="GET"){
    if(url.searchParams.get("campos")){try{const d=await shopee(`{ __type(name: "ProductOfferV2") { fields { name } } }`),campos=d.__type.fields.map(f=>f.name);return json({campos,video:campos.filter(c=>/video|media/i.test(c)),imagens:campos.filter(c=>/image|img|pic|photo/i.test(c))});}catch(e){return json({erro:e.message},500)}}
    if(url.searchParams.get("resumo")){const {data,error}=await sb.from("produtos").select("status,pedidos,itens_vendidos,valor_pedidos,comissao_estimada,comissao_validada,cliques_convertidos");if(error)return json({erro:error.message},500);const r=(data||[]).reduce((a,p)=>{a.produtos++;a.pedidos+=Number(p.pedidos||0);a.itens+=Number(p.itens_vendidos||0);a.vendas+=Number(p.valor_pedidos||0);a.estimada+=Number(p.comissao_estimada||0);a.validada+=Number(p.comissao_validada||0);a.cliques+=Number(p.cliques_convertidos||0);a.status[p.status]=(a.status[p.status]||0)+1;return a},{produtos:0,pedidos:0,itens:0,vendas:0,estimada:0,validada:0,cliques:0,status:{}});return json(r)}
    const {data,error}=await sb.from("produtos").select("*").eq("status",url.searchParams.get("status")||"pendente").order("nota",{ascending:false}).limit(100);return error?json({erro:error.message},500):json(data||[]);
  }
  const b=await req.json();
  if(b.acao==="gerar_conteudo"){
    const {data:p,error}=await sb.from("produtos").select("*").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado"},404);
    try{const c=await gerarConteudo(p);const {error:e}=await sb.from("produtos").update({...c,video_textos:c.video_textos.join("\n"),pacote_gerado_em:new Date().toISOString(),atualizado_em:new Date().toISOString()}).eq("id",b.id);return e?json({erro:e.message},500):json({ok:true,conteudo:c});}catch(e){return json({erro:e.message},500)}
  }
  if(b.acao==="upload_url"){const path=`${b.id}-${Date.now()}.${String(b.ext||"mp4").replace(/\W/g,"")}`,r=await sb.storage.from("videos").createSignedUploadUrl(path);if(r.error)return json({erro:r.error.message},500);return json({url:r.data.signedUrl,publico:sb.storage.from("videos").getPublicUrl(path).data.publicUrl});}
  const upd={atualizado_em:new Date().toISOString()};let aviso="";
  if(b.acao==="rejeitar")upd.status="rejeitado";
  else if(b.acao==="sem_video")upd.status="sem_video";
  else if(b.acao==="publicado")upd.status="publicado";
  else if(b.acao==="aprovar")Object.assign(upd,{status:"aprovado",legenda:b.legenda,plataformas:b.plataformas||[],video_url:b.video_url});
  else return json({erro:"Ação inválida"},400);
  const {error}=await sb.from("produtos").update(upd).eq("id",b.id);return error?json({erro:error.message},500):json({ok:true,aviso});
};
