import { db, json, autorizado } from "../lib.js";

const esc = s => String(s ?? "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">");
const htmlMeta = (html, name) => {
  const safe=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re=new RegExp(`<meta[^>]+(?:property|name)=["']${safe}["'][^>]+content=["']([^"']*)["'][^>]*>`,"i");
  const re2=new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${safe}["'][^>]*>`,"i");
  return esc((html.match(re)||html.match(re2)||[])[1]||"").trim();
};
const jsonLd=html=>{const out=[];for(const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const x=JSON.parse(m[1].trim());out.push(...(Array.isArray(x)?x:[x]));}catch{}}return out;};
const platformOf=url=>/tiktok\.com/i.test(url)?"tiktok":/shopee\./i.test(url)?"shopee":"outro";
const cleanUrl=url=>{try{return new URL(String(url).trim()).toString();}catch{return "";}};
const proxyImage=url=>url?`/.netlify/functions/imagem-proxy?url=${encodeURIComponent(url)}`:"";

async function fetchText(url){
  const r=await fetch(url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 (compatible; Shopee-Fila/1.0; +https://shopeefila.netlify.app)"}});
  if(!r.ok)throw new Error(`Não foi possível abrir o link (${r.status}).`);
  return {html:await r.text(),url:r.url||url};
}

async function tiktokOembed(url){
  try{
    const endpoint=`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const r=await fetch(endpoint,{headers:{"user-agent":"Mozilla/5.0 (compatible; Shopee-Fila/1.0)"}});
    if(!r.ok)return null;
    const j=await r.json();
    return {title:String(j.title||"").trim(),author:String(j.author_name||"").trim(),author_url:String(j.author_url||"").trim(),thumbnail:String(j.thumbnail_url||"").trim(),html:String(j.html||"")};
  }catch{return null;}
}

function findTikTokShopLink(text){
  const s=String(text||"").replace(/\\u002F/g,"/").replace(/\\\//g,"/");
  const matches=s.match(/https?:\/\/(?:shop\.)?tiktok\.com\/[^\"'<>\s]+/gi)||[];
  return matches.find(x=>/shop|product|goods/i.test(x))||"";
}

async function inspectTikTok(url){
  const original=cleanUrl(url);
  if(!original)throw new Error("Link do TikTok inválido.");
  const embed=await tiktokOembed(original);
  let page=null;
  try{page=await fetchText(original);}catch{}
  const finalUrl=page?.url||original;
  const html=page?.html||"";
  const embed2=embed||await tiktokOembed(finalUrl);
  const ld=jsonLd(html).find(x=>x&&(/Product|VideoObject/i.test(String(x["@type"]||""))||x.name||x.image));
  const name=htmlMeta(html,"og:title")||htmlMeta(html,"twitter:title")||String(ld?.name||"").trim()||embed2?.title||"Vídeo TikTok";
  const image=htmlMeta(html,"og:image")||htmlMeta(html,"twitter:image")||(Array.isArray(ld?.image)?ld.image[0]:ld?.image)||embed2?.thumbnail||"";
  const description=htmlMeta(html,"og:description")||htmlMeta(html,"description")||String(ld?.description||"").trim()||embed2?.title||"";
  const canonical=htmlMeta(html,"og:url")||((html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)||[])[1]||embed2?.html?.match(/cite=["']([^"']+)["']/i)?.[1]||finalUrl);
  const shopLink=findTikTokShopLink(html)||findTikTokShopLink(embed2?.html||"");
  const price=ld?.offers?.price??ld?.offers?.lowPrice??null;
  const currency=ld?.offers?.priceCurrency||"BRL";
  return {url:original,canonical,name,image,description,price,currency,platform:"tiktok",author:embed2?.author||"",author_url:embed2?.author_url||"",video_url:canonical,shop_link:shopLink,source:embed2?"tiktok_oembed":"tiktok_page"};
}

async function inspect(url){
  if(platformOf(url)==="tiktok")return inspectTikTok(url);
  const r=await fetchText(url),html=r.html,finalUrl=r.url,ld=jsonLd(html).find(x=>x&&(/Product/i.test(x["@type"]||"")||x.name||x.image));
  const name=htmlMeta(html,"og:title")||htmlMeta(html,"twitter:title")||esc(ld?.name||"")||"Produto importado";
  const image=htmlMeta(html,"og:image")||htmlMeta(html,"twitter:image")||(Array.isArray(ld?.image)?ld.image[0]:ld?.image)||"";
  const description=htmlMeta(html,"og:description")||htmlMeta(html,"description")||esc(ld?.description||"");
  const canonical=htmlMeta(html,"og:url")||((html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)||[])[1]||finalUrl);
  const price=ld?.offers?.price??ld?.offers?.lowPrice??null,currency=ld?.offers?.priceCurrency||"BRL";
  return{url:finalUrl,canonical,name,image,description,price,currency,platform:platformOf(url)};
}

export default async req=>{
 if(!autorizado(req))return json({erro:"Senha incorreta"},401);
 if(req.method!=="POST")return json({erro:"Método não permitido"},405);
 const b=await req.json().catch(()=>({}));
 if(b.acao==="deletar"){
  if(!b.id)return json({erro:"Informe o produto."},400);
  const sb=db();
  const {data,error}=await sb.from("produtos").delete().eq("id",b.id).select("id").single();
  if(error)return json({erro:"Não foi possível excluir o produto: "+error.message},500);
  if(!data)return json({erro:"Produto não encontrado."},404);
  return json({ok:true,excluido:true,id:b.id});
 }
 if(b.acao==="vincular_link"){
  if(!b.id||!b.url)return json({erro:"Informe o produto e o link."},400);
  const url=cleanUrl(b.url);if(!url)return json({erro:"Link inválido."},400);
  try{const info=await inspect(url);if(!["shopee","tiktok"].includes(info.platform))return json({erro:"O link precisa ser da Shopee ou TikTok Shop."},400);const sb=db(),{data:p,error}=await sb.from("produtos").select("id,links_plataforma,link_produto,link_afiliado,imagem").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado."},404);const links={...(p.links_plataforma||{}),[info.platform]:info.canonical||info.url};const patch={links_plataforma:links,atualizado_em:new Date().toISOString()};if(info.image&&!p.imagem)patch.imagem=info.platform==="tiktok"?proxyImage(info.image):info.image;if(info.platform==="shopee")patch.link_produto=info.canonical||info.url;else patch.link_afiliado=p.link_afiliado||info.url;const{error:e}=await sb.from("produtos").update(patch).eq("id",b.id);if(e)return json({erro:e.message},500);return json({ok:true,plataforma:info.platform,link:info.canonical||info.url,info});}catch(e){return json({erro:e.message||"Não foi possível ler o link."},400)}
 }
 const url=cleanUrl(b.url);if(!url)return json({erro:"Cole um link válido da Shopee ou TikTok Shop."},400);
 try{
  const info=await inspect(url);
  if(!["shopee","tiktok"].includes(info.platform))return json({erro:"O link precisa ser da Shopee ou TikTok Shop."},400);
  const sb=db();let existentes=[];
  for(const col of ["link_produto","link_afiliado"]){const{data}=await sb.from("produtos").select("id,nome,links_plataforma").eq(col,info.canonical||info.url).limit(1);if(data?.length)existentes.push(...data);}
  if(existentes.length)return json({ok:true,existente:true,id:existentes[0].id,info,links_plataforma:existentes[0].links_plataforma||{}});
  const agora=new Date().toISOString(),itemId=`manual_${Date.now()}`,baseLink=info.canonical||info.url,links={[info.platform]:baseLink};
  if(info.platform==="tiktok"&&info.shop_link)links.tiktok_shop=info.shop_link;
  const isTikTok=info.platform==="tiktok",nome=info.name||"Produto importado do TikTok";
  const legenda=isTikTok?`${info.description||""}${info.author?` • Criado por @${info.author}`:""}`.trim():(info.description||"");
  const row={item_id:itemId,nome,imagem:info.image?(isTikTok?proxyImage(info.image):info.image):null,preco:Number(info.price)||0,desconto:0,vendas:0,avaliacao:0,comissao:0,link_afiliado:baseLink,link_produto:isTikTok?(info.shop_link||baseLink):(info.canonical||info.url),links_plataforma:links,nota:0,motivo:isTikTok?`Importado do TikTok${info.source==="tiktok_oembed"?" via oEmbed oficial":""}. Dados de vendas, preço e comissão dependem da informação do TikTok Shop.`:"Adicionado manualmente via Shopee.",legenda,status:"pendente",atualizado_em:agora};
  const{data,error}=await sb.from("produtos").insert(row).select("*").single();
  if(error)return json({erro:"Não foi possível salvar o produto: "+error.message},500);
  return json({ok:true,produto:data,info});
 }catch(e){return json({erro:e.message||"Falha ao importar o produto."},400)}
};
