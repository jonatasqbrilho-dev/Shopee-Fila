import { db, shopee, avaliar } from "./lib.js";

const CATEGORIAS = {
  feminina: ["vestido feminino","blusa feminina","calça feminina","conjunto feminino","saia feminina","short feminino","cropped feminino","moda feminina","camiseta feminina","body feminino","macacão feminino","jaqueta feminina"],
  casa: ["organizador de cozinha","utilidades domésticas","organizador de casa","decoração de casa","cozinha","cama mesa e banho","iluminação residencial","acessórios para casa"],
  eletronicos: ["fone bluetooth","suporte de celular","carregador celular","smartwatch","caixa de som bluetooth","acessórios para celular","eletrônicos"],
  beleza: ["maquiagem","skincare","cuidados com a pele","perfume feminino","cabelo feminino","acessórios de beleza","beleza"],
  acessorios: ["bolsa feminina","carteira feminina","óculos feminino","relógio feminino","bijuterias","joias femininas","acessórios femininos"]
};
const PALAVRAS_PADRAO = (process.env.KEYWORDS_FEMININAS || CATEGORIAS.feminina.join(",")).split(",").map(s=>s.trim()).filter(Boolean);
const NOTA_MIN = Number(process.env.NOTA_MIN || 70);
const MIN_VENDAS = Number(process.env.MIN_VENDAS || 100);
const MAX_NOVOS = Number(process.env.MAX_NOVOS_COLETA || 12);
const POR_PALAVRA = Number(process.env.NOVOS_POR_PALAVRA || 2);
const PAGINAS = Number(process.env.PAGINAS_COLETA || 3);
const CAMPOS = "itemId productName imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate productLink offerLink shopName";

function palavrasDoCiclo(lista){
  const palavras = lista.length ? lista : PALAVRAS_PADRAO;
  const tamanho = palavras.length;
  const ciclo = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
  const quantidade = Math.min(6, tamanho);
  const inicio = ciclo % tamanho;
  return Array.from({length:quantidade},(_,i)=>palavras[(inicio+i)%tamanho]);
}

async function idsExistentes(sb, ids){
  if(!ids.length) return new Set();
  const {data,error}=await sb.from("produtos").select("item_id").in("item_id",ids);
  if(error) throw new Error("Supabase consulta de duplicidade: "+error.message);
  return new Set((data||[]).map(x=>String(x.item_id)));
}

export async function coletarFeminino(){ return coletarCategoria("feminina"); }

export async function coletarCategoria(categoria="feminina"){
  const sb=db();
  const lista = CATEGORIAS[categoria] || PALAVRAS_PADRAO;
  const kws=palavrasDoCiclo(lista);
  const vistosNestaColeta=new Set();
  const detalhes=[];
  let total=0;
  let atualizadosTotal=0;

  for(const kw of kws){
    const item={palavra_chave:kw,encontrados:0,elegiveis:0,novos:0,ignorados_repetidos:0,avaliados:0,gravados:0,atualizados:0,erro:null};
    try{
      const candidatos=[];
      for(let page=1;page<=PAGINAS && candidatos.length<80;page++){
        const d=await shopee(`{ productOfferV2(keyword: ${JSON.stringify(kw)}, sortType: 2, page: ${page}, limit: 20) { nodes { ${CAMPOS} } pageInfo { hasNextPage } } }`);
        const nodes=d?.productOfferV2?.nodes||[];
        item.encontrados+=nodes.length;
        for(const n of nodes){
          const id=String(n.itemId);
          if(!id || vistosNestaColeta.has(id)) continue;
          vistosNestaColeta.add(id);
          candidatos.push(n);
        }
        if(!d?.productOfferV2?.pageInfo?.hasNextPage) break;
      }

      const elegiveis=candidatos.filter(n=>Number(n.sales)>=MIN_VENDAS&&Number(n.ratingStar)>=4.5);
      item.elegiveis=elegiveis.length;
      if(!elegiveis.length){detalhes.push(item);continue;}

      const ids=await idsExistentes(sb,elegiveis.map(n=>String(n.itemId)));
      const existentes=elegiveis.filter(n=>ids.has(String(n.itemId)));
      const novos=[];
      for(const n of elegiveis){
        const id=String(n.itemId);
        if(ids.has(id)){item.ignorados_repetidos++;continue;}
        if(novos.length>=POR_PALAVRA || total+novos.length>=MAX_NOVOS) break;
        novos.push(n);
      }

      for(const n of existentes){
        const {error}=await sb.from("produtos").update({nome:n.productName,imagem:n.imageUrl,preco:Number(n.priceMin),desconto:Number(n.priceDiscountRate)||0,vendas:n.sales,avaliacao:Number(n.ratingStar),comissao:Number(n.commissionRate),link_afiliado:n.offerLink,link_produto:n.productLink,atualizado_em:new Date().toISOString()}).eq("item_id",String(n.itemId));
        if(error){item.erro=item.erro||("Falha ao atualizar item "+n.itemId+": "+error.message);}else{item.atualizados++;item.gravados++;atualizadosTotal++;}
      }
      item.novos=novos.length;

      const linhas=(await Promise.all(novos.map(async n=>{
        try{
          const a=await avaliar(n);
          item.avaliados++;
          return {item_id:String(n.itemId),nome:n.productName,imagem:n.imageUrl,preco:Number(n.priceMin),desconto:Number(n.priceDiscountRate)||0,vendas:n.sales,avaliacao:Number(n.ratingStar),comissao:Number(n.commissionRate),link_afiliado:n.offerLink,link_produto:n.productLink,nota:a.nota,motivo:a.motivo,legenda:a.legenda,status:a.nota>=NOTA_MIN?"pendente":"descartado",atualizado_em:new Date().toISOString()};
        }catch(e){item.erro=item.erro||("Falha na IA: "+e.message);return null;}
      }))).filter(Boolean);
      if(linhas.length){const {error}=await sb.from("produtos").insert(linhas);if(error)throw new Error("Supabase gravação: "+error.message);item.gravados+=linhas.length;total+=linhas.length;}
    }catch(e){item.erro=item.erro||(e instanceof Error?e.message:String(e));console.error("Coleta categoria:",categoria,kw,item.erro);}
    detalhes.push(item);
    if(total>=MAX_NOVOS) break;
  }

  const erros=detalhes.filter(x=>x.erro);
  return {total,atualizadosTotal,detalhes,categoria,erro:total===0&&atualizadosTotal===0&&erros.length?erros.map(x=>x.palavra_chave+": "+x.erro).join(" | "):null};
}

export const categoriasDisponiveis = Object.keys(CATEGORIAS);
