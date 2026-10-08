# Fila de produtos Shopee

Coleta produtos pela API de afiliados da Shopee, a IA dá nota de 0 a 100, você aprova no painel e escolhe a plataforma.

## Instalação
1. **Supabase**: crie um projeto novo e rode `supabase/schema.sql` no SQL Editor.
2. **GitHub**: suba esta pasta num repositório novo.
3. **Netlify**: crie um site novo ligado ao repositório e defina as variáveis de ambiente:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PAINEL_SENHA`, `SHOPEE_APP_ID`, `SHOPEE_SECRET`,
   `GROQ_API_KEY`, `GEMINI_API_KEY` (reserva), `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.
   Opcionais: `KEYWORDS` (separadas por vírgula), `NOTA_MIN` (padrão 70), `MIN_VENDAS` (padrão 100).
4. Abra o site, entre com a senha, toque em **Testar vídeo na API** e depois em **Coletar agora**.

## Uso
- `/` é o painel. `/links.html` é a página "link na bio" (só produtos publicados).
- Telegram é publicado pelo painel (vídeo até 20 MB). TikTok, YouTube e Instagram: baixe o vídeo, copie a legenda e poste pelo app, depois toque em **Marcar como publicado**.
- A coleta automática roda a cada 6 horas.
