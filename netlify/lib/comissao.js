export function calcularComissaoUnidade(preco, taxa) {
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
