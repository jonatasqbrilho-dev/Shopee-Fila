// Roda a cada 6 horas e dispara a coleta (função em segundo plano, sem limite de 30 s).
export default async () => {
  await fetch(`${process.env.URL}/.netlify/functions/coletar-background`, { method: "POST", headers: { "x-senha": process.env.PAINEL_SENHA } });
};
export const config = { schedule: "0 */6 * * *" };
