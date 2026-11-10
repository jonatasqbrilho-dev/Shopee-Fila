import { db, json, autorizado, shopee } from "../lib.js";
import { calcularComissaoUnidade } from "../lib/comissao.js";

const statuses = new Set(["pendente", "publicado", "ignorado"]);
const today = () => new Date().toISOString().slice(0, 10);

async function revalidarProduto(sb, productId) {
  const { data: produto, error } = await sb.from("produtos")
    .select("id,item_id,nome,preco,comissao,link_produto,link_afiliado")
    .eq("id", productId).single();
  if (error || !produto) throw new Error("Produto cadastrado não encontrado para conferência.");

  let encontrado = null;
  for (let page = 1; page <= 3 && !encontrado; page++) {
    const query = `{ productOfferV2(keyword: ${JSON.stringify(produto.nome)}, listType: 0, sortType: 2, page: ${page}, limit: 20) { nodes { itemId productName priceMin commissionRate productLink offerLink } pageInfo { hasNextPage } } }`;
    const resposta = await shopee(query);
    const resultado = resposta?.productOfferV2;
    encontrado = (resultado?.nodes || []).find(item => String(item.itemId) === String(produto.item_id)) || null;
    if (!resultado?.pageInfo?.hasNextPage) break;
  }
  if (!encontrado) throw new Error("Não consegui localizar novamente este produto na API da Shopee. Ele não foi adicionado à fila; tente atualizar a coleta.");

  const preco = Number(encontrado.priceMin);
  const comissao = Number(encontrado.commissionRate);
  const link = String(encontrado.offerLink || encontrado.productLink || "").trim();
  if (!Number.isFinite(preco) || preco <= 0) throw new Error("A Shopee não retornou um preço válido para este produto.");
  if (!Number.isFinite(comissao) || comissao <= 0) throw new Error("A Shopee não retornou comissão positiva para este produto. Confira a oferta antes de produzir.");
  let linkValido = false;
  try { const u = new URL(link); linkValido = u.protocol === "https:" && /(^|\\.)shopee\\./i.test(u.hostname); } catch {}
  if (!linkValido) throw new Error("A Shopee não retornou um link HTTPS válido para este produto.");

  const anterior = calcularComissaoUnidade(produto.preco, produto.comissao);
  const atual = calcularComissaoUnidade(preco, comissao);
  const { error: updateError } = await sb.from("produtos").update({
    preco, comissao, link_produto: encontrado.productLink || produto.link_produto,
    link_afiliado: encontrado.offerLink || produto.link_afiliado,
    atualizado_em: new Date().toISOString()
  }).eq("id", productId);
  if (updateError) throw new Error("Não foi possível atualizar os dados conferidos: " + updateError.message);

  if (anterior != null && atual < anterior) {
    throw new Error(`A comissão estimada caiu de R$ ${anterior.toFixed(2)} para R$ ${atual.toFixed(2)} por unidade. Os dados foram atualizados; confira o produto antes de tentar adicioná-lo novamente.`);
  }
  return {
    nome: encontrado.productName || produto.nome,
    preco,
    comissao,
    link,
    avisos: ["A API consultada não fornece estoque no conjunto de campos utilizado; estoque não pôde ser confirmado."]
  };
}

export default async (req) => {
  if (!autorizado(req)) return json({ erro: "Senha incorreta" }, 401);
  const sb = db();
  const url = new URL(req.url);

  if (req.method === "GET") {
    const date = url.searchParams.get("date") || today();
    const { data, error } = await sb.from("shopee_video_queue").select("*")
      .eq("scheduled_date", date).order("position", { ascending: true }).order("created_at", { ascending: true });
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true, date, items: data || [] });
  }

  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  const body = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  if (body.acao === "adicionar") {
    const name = String(body.product_name || "").trim();
    const date = String(body.scheduled_date || today());
    if (!name) return json({ erro: "Informe o nome do produto." }, 400);
    const { data: countRows, error: countError } = await sb.from("shopee_video_queue").select("id")
      .eq("scheduled_date", date).neq("status", "ignorado");
    if (countError) return json({ erro: countError.message }, 500);
    if ((countRows || []).length >= 10) return json({ erro: "A fila diária já tem 10 vídeos. Escolha outra data ou remova um item." }, 400);
    let nomeFila = name;
    let linkFila = String(body.product_url || "").trim() || null;
    let avisos = [];
    if (body.product_id) {
      try {
        const conferido = await revalidarProduto(sb, String(body.product_id));
        nomeFila = conferido.nome;
        linkFila = conferido.link;
        avisos = conferido.avisos;
      } catch (e) {
        return json({ erro: e.message || "Não foi possível conferir o produto na Shopee." }, 409);
      }
    } else {
      avisos.push("Produto inserido manualmente: comissão e estoque não foram revalidados pela API.");
    }
    const item = {
      product_id: body.product_id || null,
      product_name: nomeFila.slice(0, 300),
      product_url: linkFila,
      video_url: String(body.video_url || "").trim() || null,
      caption: String(body.caption || "").trim().slice(0, 150),
      scheduled_date: date,
      position: (countRows || []).length + 1,
      status: "pendente",
      updated_at: now
    };
    const { data, error } = await sb.from("shopee_video_queue").insert(item).select("*").single();
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true, item: data, avisos });
  }

  if (body.acao === "atualizar") {
    const id = String(body.id || "");
    const patch = { updated_at: now };
    if (typeof body.caption === "string") patch.caption = body.caption.slice(0, 150);
    if (typeof body.video_url === "string") patch.video_url = body.video_url.trim() || null;
    if (typeof body.product_url === "string") patch.product_url = body.product_url.trim() || null;
    if (typeof body.product_name === "string" && body.product_name.trim()) patch.product_name = body.product_name.trim().slice(0, 300);
    if (Number.isInteger(body.position) && body.position > 0) patch.position = body.position;
    if (body.status && statuses.has(body.status)) {
      patch.status = body.status;
      patch.published_at = body.status === "publicado" ? now : null;
    }
    const { data, error } = await sb.from("shopee_video_queue").update(patch).eq("id", id).select("*").single();
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true, item: data });
  }

  if (body.acao === "excluir") {
    const { error } = await sb.from("shopee_video_queue").delete().eq("id", String(body.id || ""));
    if (error) return json({ erro: error.message }, 500);
    return json({ ok: true });
  }

  return json({ erro: "Ação inválida." }, 400);
};
