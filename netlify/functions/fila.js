import { db, json, autorizado, shopee, gerarConteudo } from "../lib.js";

const escGql=s=>String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"');
const platformSub=(p,k)=>`${k}${String(p.item_id).replace(/\D/g,"").slice(-12)}`;

async function gerarLinks(p){
  const out={},erros={};
  for(const k of ["tiktok","youtube","instagram","telegram"]){const sub=platformSub(p,k);const q=`mutation { generateShortLink(input:{originUrl:"${escGql(p.link_produto||p.link_afiliado)}",subIds:["${escGql(sub)}"]}) { shortLink } }`;try{out[k]=(await shopee(q)).generateShortLink.shortLink;}catch(e){out[k]=null;erros[k]=e.message;}}
  return {out,erros};
}

async function sincronizarConversoes(sb){
  const end=Math.floor(Date.now()/1000),start=end-30*24*60*60;
  const q=`{ conversionReport(purchaseTimeStart:${start},purchaseTimeEnd:${end},limit:500) { nodes { clickTime purchaseTime conversionId totalCommission netCommission utmContent orders { orderId orderStatus items { itemId itemName itemPrice qty itemTotalCommission attributionType } } } pageInfo { hasNextPage scrollId } } }`;
  const d=await shopee(q),nodes=d.conversionReport?.nodes||[],byItem=new Map();
  for(const n of nodes)for(const o of(n.orders||[]))for(const it of(o.items||[])){const id=String(it.itemId),x=byItem.get(id)||{cliques:0,pedidos:new Set(),itens:0,vendas:0,estimada:0};if(n.clickTime)x.cliques++;x.pedidos.add(String(o.orderId));x.itens+=Number(it.qty||0);x.vendas+=Number(it.itemPrice||0)*Number(it.qty||0);x.estimada+=Number(it.itemTotalCommission||0);byItem.set(id,x);}
  let atualizados=0;for(const [item_id,x] of byItem){const pedidos=x.pedidos.size,conversao=x.cliques?Number((pedidos/x.cliques*100).toFixed(2)):0;const {error}=await sb.from("produtos").update({cliques_convertidos:x.cliques,pedidos,itens_vendidos:x.itens,valor_pedidos:Number(x.vendas.toFixed(2)),comissao_estimada:Number(x.estimada.toFixed(2)),conversao,ultima_sincronizacao:new Date().toISOString(),metricas_status:"conversionReport sincronizado (30 dias)",atualizado_em:new Date().toISOString()}).eq("item_id",item_id);if(!error)atualizados++;}
  return {conversoes:nodes.length,produtos_atualizados:atualizados,janela_dias:30,aviso:"A API de conversionReport informa cliques associados a conversões; o total bruto de cliques do relatório de cliques da Shopee não é exposto por este endpoint."};
}

const mptBase=()=>String(process.env.MONEYPRINTERTURBO_URL||"").replace(/\/$/,"");
const mptHeaders=()=>{const h={};if(process.env.MONEYPRINTERTURBO_API_KEY)h["x-api-key"]=process.env.MONEYPRINTERTURBO_API_KEY;return h;};
async function mptFetch(path,opts={}){const base=mptBase();if(!base)throw new Error("MoneyPrinterTurbo não configurado. Defina MONEYPRINTERTURBO_URL no Netlify.");const headers={...mptHeaders(),...(opts.headers||{})};const r=await fetch(base+path,{...opts,headers});const text=await r.text();let data={};try{data=JSON.parse(text)}catch{data={raw:text}}if(!r.ok)throw new Error(`MoneyPrinterTurbo ${r.status}: ${JSON.stringify(data).slice(0,500)}`);return data;}
const mptData=x=>x?.data||x;

async function mptHealth(){const base=mptBase();if(!base)return {configurado:false,online:false};try{const r=await fetch(base+"/api/v1/tasks?page=1&page_size=1",{headers:mptHeaders()});return {configurado:true,online:r.ok,status:r.status,url:base};}catch(e){return {configurado:true,online:false,url:base,erro:e.message};}}

async function gerarVideoMpt(p,sb){
  const base=mptBase();if(!base)throw new Error("MoneyPrinterTurbo não configurado. Defina MONEYPRINTERTURBO_URL no Netlify.");
  if(!p.imagem)throw new Error("Produto sem imagem para o MoneyPrinterTurbo.");
  const img=await fetch(p.imagem);if(!img.ok)throw new Error(`Não foi possível baixar a imagem do produto (${img.status}).`);
  const blob=await img.blob();
  const nome=`produto-${String(p.item_id||p.id).replace(/\D/g,"")||Date.now()}.jpg`;
  const form=new FormData();form.append("file",blob,nome);
  const upload=await mptFetch("/api/v1/video_materials",{method:"POST",headers:mptHeaders(),body:form});
  const arquivo=mptData(upload)?.file;if(!arquivo)throw new Error("MoneyPrinterTurbo não retornou o arquivo de material.");
  const materiais=Array.from({length:5},()=>({provider:"local",url:arquivo,duration:5}));
  const payload={video_subject:p.nome||"Produto Shopee",video_script:removerTextoPromocional(p.video_prompt||p.nome||"Apresente o produto com fidelidade ao anúncio."),video_aspect:"9:16",video_fit_mode:"cover",video_concat_mode:"sequential",video_transition_mode:"Shuffle",video_clip_duration:5,video_clip_speed:1,match_materials_to_script:false,video_count:1,video_source:"local",video_materials:materiais,video_language:"pt-BR",voice_name:"",voice_volume:0,bgm_type:"random",bgm_volume:0.15,subtitle_enabled:false,paragraph_number:1,video_script_prompt:"",custom_system_prompt:""};
  const criado=mptData(await mptFetch("/api/v1/videos",{method:"POST",headers:{...mptHeaders(),"Content-Type":"application/json"},body:JSON.stringify(payload)}));
  const task=criado?.task_id?criado:criado?.data||criado;if(!task?.task_id)throw new Error("MoneyPrinterTurbo não retornou o ID da tarefa.");
  const agora=new Date().toISOString();
  const {error}=await sb.from("produtos").update({mpt_task_id:task.task_id,mpt_status:"processing",mpt_video_url:null,mpt_atualizado_em:agora,atualizado_em:agora}).eq("id",p.id);if(error)throw new Error("Falha ao salvar tarefa MPT: "+error.message);
  return {task_id:task.task_id,status:"processing"};
}

const removerTextoPromocional=s=>String(s||"").replace(/R\$\s?\d+(?:[.,]\d{2})?/gi,"").replace(/\b\d+[.,]\d{2}\s?(?:reais)?\b/gi,"").replace(/\b(?:desconto|promoção|promocao)\b/gi,"").replace(/\s{2,}/g," ").trim();

async function consultarMpt(p,sb){
  if(!p.mpt_task_id)return {status:"not_started"};
  const d=mptData(await mptFetch(`/api/v1/tasks/${encodeURIComponent(p.mpt_task_id)}`));
  const status=String(d?.state||d?.status||"processing").toLowerCase();
  const videos=d?.videos||d?.combined_videos||[];
  let videoUrl=Array.isArray(videos)&&videos[0]?videos[0]:null;
  if(videoUrl&&!/^https?:\/\//i.test(videoUrl)){videoUrl=mptBase()+"/api/v1/stream/"+String(videoUrl).replace(/^\//,"");}
  const terminal=/^(completed|success|succeeded|done|finished)$/i.test(status),failed=/^(failed|error|cancelled|canceled)$/i.test(status);
  const finalStatus=failed?"error":terminal?"completed":"processing";
  const agora=new Date().toISOString();
  const patch={mpt_status:finalStatus,mpt_video_url:videoUrl,mpt_atualizado_em:agora,atualizado_em:agora};
  await sb.from("produtos").update(patch).eq("id",p.id);
  return {task_id:p.mpt_task_id,status:finalStatus,video_url:videoUrl,raw:d};
}

export default async(req)=>{
  const sb=db(),url=new URL(req.url);
  if(req.method==="GET"&&url.searchParams.get("publico")){const {data}=await sb.from("produtos").select("nome,imagem,link_afiliado,legenda,hashtags").eq("status","publicado").order("atualizado_em",{ascending:false}).limit(60);return json(data||[]);}
  if(!autorizado(req))return json({erro:"Senha incorreta"},401);
  if(req.method==="GET"){
    if(url.searchParams.get("mpt")){return json(await mptHealth());}
    if(url.searchParams.get("campos")){try{const d=await shopee(`{ __type(name: "ProductOfferV2") { fields { name } } }`),campos=d.__type.fields.map(f=>f.name);return json({campos,video:campos.filter(c=>/video|media/i.test(c)),imagens:campos.filter(c=>/image|img|pic|photo/i.test(c))});}catch(e){return json({erro:e.message},500)}}
    if(url.searchParams.get("resumo")){const {data,error}=await sb.from("produtos").select("status,pedidos,itens_vendidos,valor_pedidos,comissao_estimada,comissao_validada,cliques_convertidos");if(error)return json({erro:error.message},500);const r=(data||[]).reduce((a,p)=>{a.produtos++;a.pedidos+=Number(p.pedidos||0);a.itens+=Number(p.itens_vendidos||0);a.vendas+=Number(p.valor_pedidos||0);a.estimada+=Number(p.comissao_estimada||0);a.validada+=Number(p.comissao_validada||0);a.cliques+=Number(p.cliques_convertidos||0);a.status[p.status]=(a.status[p.status]||0)+1;return a},{produtos:0,pedidos:0,itens:0,vendas:0,estimada:0,validada:0,cliques:0,status:{}});return json(r)}
    const {data,error}=await sb.from("produtos").select("*").eq("status",url.searchParams.get("status")||"pendente").order("atualizado_em",{ascending:false}).limit(100);if(error)return json({erro:error.message},500);
    const limpos=(data||[]).map(p=>({...p,video_roteiro:null,video_narracao:null,video_textos:null,video_cta:null,hashtags:[]}));return json(limpos);
  }
  const b=await req.json();
  if(b.acao==="mpt_status"){try{const {data:p,error}=await sb.from("produtos").select("*").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado"},404);return json({ok:true,...await consultarMpt(p,sb)});}catch(e){return json({erro:e.message},500)}}
  if(b.acao==="gerar_video_mpt"){try{const {data:p,error}=await sb.from("produtos").select("*").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado"},404);return json({ok:true,...await gerarVideoMpt(p,sb)});}catch(e){return json({erro:e.message},500)}}
  if(b.acao==="gerar_conteudo"){
    const {data:p,error}=await sb.from("produtos").select("*").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado"},404);
    try{
      const c=await gerarConteudo(p);
      const {error:e}=await sb.from("produtos").update({nota:c.nota,motivo:c.motivo,legenda:c.legenda,video_prompt:c.video_prompt,video_roteiro:null,video_narracao:null,video_textos:null,video_cta:null,hashtags:[],pacote_gerado_em:new Date().toISOString(),atualizado_em:new Date().toISOString()}).eq("id",b.id);
      return e?json({erro:e.message},500):json({ok:true,conteudo:c});
    }catch(e){return json({erro:e.message},500)}
  }
  if(b.acao==="gerar_links"){const {data:p,error}=await sb.from("produtos").select("*").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado"},404);const r=await gerarLinks(p),links=r.out,subs=["tiktok","youtube","instagram","telegram"].map(k=>platformSub(p,k));const {error:e}=await sb.from("produtos").update({links_plataforma:links,sub_ids:subs,atualizado_em:new Date().toISOString()}).eq("id",b.id);if(e)return json({erro:e.message},500);const gerados=Object.values(links).filter(Boolean).length;return gerados?json({ok:true,links,gerados,total:4}):json({erro:"Shopee não gerou nenhum link.",detalhes:r.erros},400);}
  if(b.acao==="sincronizar_metricas"){try{return json({ok:true,...await sincronizarConversoes(sb)});}catch(e){return json({erro:e.message},500)}}
  if(b.acao==="upload_url"){const path=`${b.id}-${Date.now()}.${String(b.ext||"mp4").replace(/\W/g,"")}`,r=await sb.storage.from("videos").createSignedUploadUrl(path);if(r.error)return json({erro:r.error.message},500);return json({url:r.data.signedUrl,publico:sb.storage.from("videos").getPublicUrl(path).data.publicUrl});}
  const upd={atualizado_em:new Date().toISOString()};let aviso="";if(b.acao==="rejeitar")upd.status="rejeitado";else if(b.acao==="sem_video")upd.status="sem_video";else if(b.acao==="publicado")upd.status="publicado";else if(b.acao==="aprovar")Object.assign(upd,{status:"aprovado",legenda:b.legenda,plataformas:b.plataformas||[],video_url:b.video_url||b.mpt_video_url||null});else return json({erro:"Ação inválida"},400);const {error}=await sb.from("produtos").update(upd).eq("id",b.id);return error?json({erro:error.message},500):json({ok:true,aviso});
};
