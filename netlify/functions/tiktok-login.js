import crypto from "node:crypto";

const REDIRECT_URI = "https://shopeefila.netlify.app/tiktok/callback";
const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";

export default async function handler() {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey || !process.env.TIKTOK_CLIENT_SECRET) {
    return new Response("TikTok não está configurado no Netlify.", { status: 500 });
  }

  const state = crypto.randomBytes(32).toString("hex");
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: "code",
    scope: "user.info.basic,video.publish",
    redirect_uri: REDIRECT_URI,
    state
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${AUTH_URL}?${params.toString()}`,
      "Set-Cookie": `tiktok_oauth_state=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
    }
  });
}
