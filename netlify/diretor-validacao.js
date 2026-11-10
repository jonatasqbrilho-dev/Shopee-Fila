// Funções puras de validação do Diretor IA.
export const DURACAO_PADRAO_DIRETOR = 10;
export const LIMITE_FALA_DIRETOR = 22;
export function extrairQuantidadeKit(nome, descricao = "", caracteristicas = "", variacao = "") {
  const texto = [nome, descricao, caracteristicas, variacao].filter(Boolean).join(" ").toLowerCase();
  const match = texto.match(/\\bkit\\s+(?:com\\s+|de\\s+)?(\\d{1,2})\\b|\\b(\\d{1,2})\\s*(?:peças?|pecas?|unidades?|unid\\.?)\\b/i);
  const quantidade = Number(match?.[1] || match?.[2] || 0);
  return Number.isInteger(quantidade) && quantidade >= 2 && quantidade <= 50 ? quantidade : null;
}
export const palavras = s => String(s || "").trim().split(/\s+/).filter(Boolean);
export const normalizarTexto = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export const legendaSegura = s => {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  t = t.replace(/R\$\s?\d+(?:[.,]\d{1,2})?/gi, "")
    .replace(/\b(?:por|pre[cç]o|valor)\s*(?:de\s*)?\d+(?:[.,]\d{1,2})?/gi, "")
    .replace(/\b\d+(?:[.,]\d{1,2})?\s*(?:reais?|vendidos?|vendas?|compradores?|clientes?|unidades?|estrelas?)\b/gi, "")
    .replace(/\b\d{1,3}\s?%/g, "")
    .replace(/\b(?:desconto|promo[cç][aã]o|oferta|mais vendido|viral|recorde de vendas|milhares de vendas|ranking|avalia[cç][oõ]es|vendidos|vendas)\b/gi, "")
    .replace(/\s{2,}/g, " ").trim();
  if (t.length > 150) t = t.slice(0, 150).replace(/\s+\S*$/, "").trim();
  return t;
};
export function palavraChaveProduto(nome) {
  const stop = new Set(["de","da","do","das","dos","com","para","em","e","o","a","os","as","kit","unidade","unidades","novo","nova"]);
  const termos = String(nome || "").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .filter(x => x.length > 2 && !stop.has(normalizarTexto(x)));
  return termos.slice(0, 3).join(" ").toLowerCase() || "produto";
}
export function validarGanchos(ganchos) {
  const tipos = ["Problema e solução", "Curiosidade", "Demonstração"];
  const entrada = Array.isArray(ganchos) ? ganchos : [];
  const saida = tipos.map((tipo, i) => {
    const g = entrada[i] || {};
    const texto = String(g.texto || g.gancho || "").trim();
    const abertura = String(g.abertura_visual || g.visual || "").trim();
    return { tipo, texto: texto.slice(0, 180), abertura_visual: abertura.slice(0, 240) };
  });
  if (saida.some(g => !g.texto || !g.abertura_visual || palavras(g.texto).length > 12)) {
    throw new Error("A IA não retornou três ganchos completos de até 12 palavras. Tente novamente.");
  }
  if (new Set(saida.map(g => normalizarTexto(g.texto))).size !== 3) {
    throw new Error("Os três ganchos precisam ser diferentes entre si. Gere novamente.");
  }
  return saida;
}
export function validarContinuidade(c) {
  const base = c && typeof c === "object" ? c : {};
  return {
    pessoa: String(base.pessoa || "Produto em destaque, sem apresentador").slice(0, 180),
    roupa: String(base.roupa || "Manter a mesma roupa durante todo o vídeo").slice(0, 180),
    cenario: String(base.cenario || "Manter o mesmo cenário durante todo o vídeo").slice(0, 180),
    iluminacao: String(base.iluminacao || "Iluminação constante").slice(0, 180),
    camera: String(base.camera || "Enquadramento vertical estável").slice(0, 180)
  };
}
