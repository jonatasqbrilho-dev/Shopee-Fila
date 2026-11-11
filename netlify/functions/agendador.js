// Alterna as categorias a cada 6 horas e dispara a coleta em segundo plano.
// O cron da Netlify usa UTC; a rotação é global e não depende do fuso do usuário.
const CATEGORIAS = ["feminina", "casa", "eletronicos", "beleza", "acessorios"];

export default async () => {
  const url = process.env.URL;
  const senha = process.env.PAINEL_SENHA;
  if (!url || !senha) {
    console.error("Agendador Shopee: URL ou PAINEL_SENHA não configurado.");
    return;
  }

  // Cada janela de 6 horas processa uma categoria diferente.
  // Em 30 horas, todas as cinco categorias passam pela coleta.
  const ciclo = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
  const categoria = CATEGORIAS[ciclo % CATEGORIAS.length];

  const resposta = await fetch(`${url.replace(/\/$/, "")}/.netlify/functions/coletar-background`, {
    method: "POST",
    headers: {
      "x-senha": senha,
      "content-type": "application/json"
    },
    body: JSON.stringify({ categoria })
  });

  if (!resposta.ok && resposta.status !== 202) {
    const detalhe = await resposta.text().catch(() => "");
    throw new Error(`Falha ao iniciar coleta da categoria ${categoria}: HTTP ${resposta.status} ${detalhe.slice(0, 300)}`);
  }

  console.log(`Coleta agendada iniciada: ${categoria}`);
};

export const config = { schedule: "0 */6 * * *" };
