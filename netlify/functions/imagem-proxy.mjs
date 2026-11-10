const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const ALLOWED_HOSTS = [
  /(^|\.)susercontent\.com$/i,
  /(^|\.)shopee\.com\.br$/i,
  /(^|\.)tiktokcdn\.com$/i,
  /(^|\.)tiktokcdn-us\.com$/i,
  /(^|\.)byteoversea\.com$/i,
  /(^|\.)ibytedtos\.com$/i,
  /(^|\.)tiktokv\.com$/i
];

function validarDestino(url) {
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return false;
  return ALLOWED_HOSTS.some(regra => regra.test(url.hostname));
}

export default async req => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Método não permitido", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const target = new URL(req.url).searchParams.get("url");
    if (!target) return new Response("Imagem não informada", { status: 400 });

    let url;
    try { url = new URL(target); } catch { return new Response("URL inválida", { status: 400 }); }
    if (!validarDestino(url)) return new Response("Domínio de imagem não autorizado", { status: 403 });

    let response;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      response = await fetch(url.toString(), {
        redirect: "manual",
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Shopee-Fila/1.0)",
          "referer": "https://www.tiktok.com/"
        },
        signal: AbortSignal.timeout(10000)
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) {
        return new Response("Redirecionamento de imagem inválido", { status: 502 });
      }
      try { url = new URL(location, url); } catch { return new Response("Redirecionamento inválido", { status: 502 }); }
      if (!validarDestino(url)) return new Response("Redirecionamento para domínio não autorizado", { status: 403 });
    }

    if (!response?.ok) return new Response("Não foi possível carregar a imagem", { status: response?.status || 502 });

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) return new Response("O endereço não retornou um formato de imagem permitido", { status: 415 });

    const tamanhoDeclarado = Number(response.headers.get("content-length") || 0);
    if (tamanhoDeclarado > MAX_BYTES) return new Response("Imagem maior que o limite permitido", { status: 413 });

    if (req.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "public, max-age=86400, s-maxage=604800",
          "x-content-type-options": "nosniff"
        }
      });
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) return new Response("Imagem maior que o limite permitido", { status: 413 });

    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(bytes.byteLength),
        "cache-control": "public, max-age=86400, s-maxage=604800",
        "x-content-type-options": "nosniff"
      }
    });
  } catch (e) {
    console.error("imagem-proxy:", e?.message || e);
    return new Response("Erro ao carregar imagem", { status: 502 });
  }
};
