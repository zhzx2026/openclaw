# OpenClaw Chat Worker

Password-protected chat app on Cloudflare Workers with:

- password login
- OpenAI Responses API chat
- image / PDF / text-file attachments for chat context
- R2-backed upload and download
- GitHub Actions deployment to `chat.sunsetzhong.indevs.in`

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local secrets:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Fill `.dev.vars`:

   - `OPENAI_API_KEY=<your key>`
   - `SESSION_SECRET=<long random string>`
   - `CHAT_PASSWORD=123567`

4. Create the R2 bucket once:

   ```bash
   npx wrangler r2 bucket create openclaw-chat-files --location=enam
   ```

5. Start local dev:

   ```bash
   npm run dev
   ```

## GitHub Actions secrets

Add these repository secrets before enabling auto deploy:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENAI_API_KEY`
- `SESSION_SECRET`
- `CHAT_PASSWORD` set to `123567`

## Notes

- `wrangler.jsonc` is already configured for the custom domain `chat.sunsetzhong.indevs.in`.
- Attachments are stored in the `openclaw-chat-files` R2 bucket.
- Images, PDFs, and common text documents are sent to the model. Other files are still stored and downloadable, but are not injected into model context.
