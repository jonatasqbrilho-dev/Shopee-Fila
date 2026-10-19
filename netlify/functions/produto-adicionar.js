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
const cleanUrl=url=>{try{return new URL(url).toString();}catch{return "";}};
async function inspect(url){const r=await fetch(url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 (compatible; Shopee-Fila/1.0)"}});if(!r.ok)throw new Error(`Não foi possível abrir o link (${r.status}).`);const html=await r.text(),finalUrl=r.url||url,ld=jsonLd(html).find(x=>x&&(/Product/i.test(x["@type"]||"")||x.name||x.image));const name=htmlMeta(html,"og:title")||htmlMeta(html,"twitter:title")||esc(ld?.name||"")||"Produto importado",image=htmlMeta(html,"og:image")||htmlMeta(html,"twitter:image")||(Array.isArray(ld?.image)?ld.image[0]:ld?.image)||"",description=htmlMeta(html,"og:description")||htmlMeta(html,"description")||esc(ld?.description||""),canonical=htmlMeta(html,"og:url")||((html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)||[])[1]||finalUrl),price=ld?.offers?.price??ld?.offers?.lowPrice??null,currency=ld?.offers?.priceCurrency||"BRL";return{url:finalUrl,canonical,name,image,description,price,currency,platform:platformOf(finalUrl)};}

export default async req=>{
 if(!autorizado(req))return json({erro:"Senha incorreta"},401);if(req.method!=="POST")return json({erro:"Método não permitido"},405);const b=await req.json().catch(()=>({}));
 if(b.acao==="vincular_link"){
  if(!b.id||!b.url)return json({erro:"Informe o produto e o link."},400);const url=cleanUrl(b.url);if(!url)return json({erro:"Link inválido."},400);
  try{const info=await inspect(url);if(!["shopee","tiktok"].includes(info.platform))return json({erro:"O link precisa ser da Shopee ou TikTok Shop."},400);const sb=db(),{data:p,error}=await sb.from("produtos").select("id,links_plataforma,link_produto,link_afiliado").eq("id",b.id).single();if(error||!p)return json({erro:error?.message||"Produto não encontrado."},404);const links={...(p.links_plataforma||{}),[info.platform]:info.canonical||info.url};const patch={links_plataforma:links,atualizado_em:new Date().toISOString()};if(info.platform==="shopee")patch.link_produto=info.canonical||info.url;else patch.link_afiliado=p.link_afiliado||info.url;const{error:e}=await sb.from("produtos").update(patch).eq("id",b.id);if(e)return json({erro:e.message},500);return json({ok:true,plataforma:info.platform,link:info.canonical||info.url,info});}catch(e){return json({erro:e.message||"Não foi possível ler o link."},400)}
 }
 const url=cleanUrl(b.url);if(!url)return json({erro:"Cole um link válido da Shopee ou TikTok Shop."},400);
 try{const info=await inspect(url);if(!["shopee","tiktok"].includes(info.platform))return json({erro:"O link precisa ser da Shopee ou TikTok Shop."},400);const sb=db();let existentes=[];for(const col of ["link_produto","link_afiliado"]){const{data}=await sb.from("produtos").select("id,nome,links_plataforma").eq(col,info.canonical||info.url).limit(1);if(data?.length)existentes.push(...data);}if(existentes.length)return json({ok:true,existente:true,id:existentes[0].id,info,links_plataforma:existentes[0].links_plataforma||{}});
  const agora=new Date().toISOString(),itemId=`manual_${Date.now()}`,links={[info.platform]:info.canonical||info.url};const row={item_id:itemId,nome:info.name||"Produto importado",imagem:info.image||null,preco:Number(info.price)||0,desconto:0,vendas:0,avaliacao:0,comissao:0,link_afiliado:info.url,link_produto:info.platform==="shopee"?info.canonical||info.url:null,links_plataforma:links,nota:0,motivo:`Adicionado manualmente via ${info.platform==="tiktok"?"TikTok Shop":"Shopee"}.`,legenda:info.description||"",status:"pendente",atualizado_em:agora};const{data,error}=await sb.from("produtos").insert(row).select("*").single();if(error)return json({erro:"Não foi possível salvar o produto: "+error.message},500);return json({ok:true,produto:data,info});
 }catch(e){return json({erro:e.message||"Falha ao importar o produto."},400)}
};
