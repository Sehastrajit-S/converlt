# Converlt Gateway

The gateway holds the credits ledger. It launches and bills RunPod GPUs, and proxies OpenRouter models, all behind one Converlt token (`cvt_…`). The provider keys stay on the gateway.

It runs in two places:

| Where | Database | Metering |
| --- | --- | --- |
| Your own computer (the IDE's "Use my own keys" mode, or `pnpm start`) | SQLite file in `CONVERLT_DATA_DIR` | a loop every 30 s |
| Vercel (Converlt accounts) | Postgres (`DATABASE_URL`, e.g. Neon) | a Vercel cron calling `/cron/meter` every minute |

## Deploy on Vercel

1. **Create the project.** In Vercel, choose New Project and import the GitHub repo. Set **Root Directory** to `services/gateway`. Leave the framework preset as "Other". `vercel.json` sets the install and build commands.
2. **Add the database.** Under the project's Storage tab, add **Neon** (Postgres) from the Marketplace. This sets `DATABASE_URL`. The tables are created on the first request.
3. **Set environment variables** (Settings → Environment Variables, Production):

   | Variable | Value |
   | --- | --- |
   | `RUNPOD_API_KEY` | RunPod → Settings → API Keys. Use a key with read/write access to pods. |
   | `OPENROUTER_API_KEY` | OpenRouter → Keys. Set a credit limit on the key as a backstop. |
   | `CONVERLT_ADMIN_TOKEN` | A long random string, e.g. `openssl rand -base64 48`. It guards `/admin/*`. |
   | `CRON_SECRET` | Another long random string. Vercel sends it with each cron call. |
   | `CONVERLT_PUBLIC_URL` | Optional. Your domain, e.g. `https://api.converlt.com`. Defaults to the project's production URL. |
   | `GPU_MARKUP`, `MODEL_MARKUP`, `CREDITS_PER_USD` | Optional. Defaults are 1.1, 1.05 and 100. |

4. **Deploy**, then check `https://<your-project>.vercel.app/health`. It should return `{"ok":true,"gpu":true,"models":true}`.
5. **Create users** with the admin token:

   ```bash
   curl -X POST https://<gateway>/admin/users \
     -H "Authorization: Bearer $CONVERLT_ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"email":"you@example.com","credits":500}'
   ```

   The response contains the user's token, shown once. To sign in, open the IDE and go to Wallet → Converlt account. Enter the gateway URL and that token.

   Other admin calls: `POST /admin/credits {email, credits, note}` adds or removes credits; `POST /admin/rotate-token {email}` issues a new token; `GET /admin/users` lists users. The CLI also works against the hosted database: `DATABASE_URL=… pnpm admin users`.

Notes:

- The cron runs every minute, which requires Vercel Pro. On Hobby, Vercel runs cron jobs only once a day. That is too slow to stop pods when credits run out.
- One function serves every route, with streaming enabled. Chat completions stream through as they arrive, and are charged from the final usage chunk.
- Charges are safe to run concurrently. A user's stop request and the cron can both bill the same pod, and each interval is still billed exactly once.

## Develop

```bash
pnpm start                 # SQLite in ./data, port 8787
pnpm test                  # the suite runs twice: on SQLite and on Postgres (PGlite)
pnpm build:vercel          # writes .vercel/output (Build Output API)
```
