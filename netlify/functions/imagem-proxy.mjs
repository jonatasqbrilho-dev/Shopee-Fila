export default async (req) => {
  try {
    const target = new URL(req.url).searchParams.get("url");
    if (!target) return new Response("Imagem não informada", { status: 400 });

    const u = new URL(target);
    if (!/^(https?:)$/.test(u.protocol)) {
      return new Response("URL inválida", { status: 400 });
    }

    const r = await fetch(u.toString(), {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Shopee-Fila/1.0)",
        "referer": "https://www.tiktok.com/"
      }
    });

    if (!r.ok) return new Response("Não foi possível carregar a imagem", { status: r.status });

    const contentType = r.headers.get("content-type") || "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return new Response("O endereço não retornou uma imagem", { status: 415 });
    }

    return new Response(r.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=86400, s-maxage=604800"
      }
    });
  } catch (e) {
    return new Response("Erro ao carregar imagem", { status: 400 });
  }
};
