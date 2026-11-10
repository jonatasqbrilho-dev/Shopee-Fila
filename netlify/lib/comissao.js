export function calcularComissaoUnidade(preco, taxa) {
  if (preco == null || preco === "" || taxa == null || taxa === "") return null;
  const valor = Number(preco);
  const percentual = Number(taxa);
  if (!Number.isFinite(valor) || valor <= 0 || !Number.isFinite(percentual) || percentual < 0) return null;
  return Math.round((valor * percentual + Number.EPSILON) * 100) / 100;
}

export function ordenarPorComissaoUnidade(produtos, direcao = "desc") {
  const fator = direcao === "asc" ? 1 : -1;
  return [...produtos].sort((a, b) => {
    const av = a.comissao_unidade;
    const bv = b.comissao_unidade;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * fator;
  });
}

export function produtoElegivel(produto, minVendas = 100, minAvaliacao = 4.5) {
  const vendas = Number(produto?.sales);
  const avaliacao = Number(produto?.ratingStar);
  return Number.isFinite(vendas) && Number.isFinite(avaliacao)
    && vendas >= minVendas && avaliacao >= minAvaliacao;
}
