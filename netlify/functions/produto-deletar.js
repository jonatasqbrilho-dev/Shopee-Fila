import { db, json, autorizado } from "../lib.js";

export default async (req) => {
  if (!autorizado(req)) return json({ erro: "Senha incorreta" }, 401);
  if (req.method !== "POST" && req.method !== "DELETE") return json({ erro: "Método não permitido" }, 405);

  try {
    const body = req.method === "DELETE" ? {} : await req.json();
    const id = body.id || new URL(req.url).searchParams.get("id");
    if (!id) return json({ erro: "ID do produto não informado" }, 400);

    const sb = db();
    const { error } = await sb.from("produtos").delete().eq("id", id);
    if (error) return json({ erro: error.message }, 500);

    return json({ ok: true, id });
  } catch (e) {
    return json({ erro: e.message || "Falha ao excluir produto" }, 500);
  }
};
