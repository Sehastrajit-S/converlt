# Converlt privacy policy

Last updated: November 5, 2026

Converlt is a desktop IDE for training machine-learning models. This policy explains what data the Converlt app and the optional Converlt Cloud service handle, and why.

## The short version

- **Using the IDE on its own sends nothing to us.** Your code, data, runs and settings stay on your computer and on the machines you connect it to.
- **Converlt Cloud is optional.** Only if you sign in does the app talk to our service, and then only to run your account: your sign-in, your credits, and the cloud GPUs and AI models you use.
- **No telemetry, no ads, no selling data.** Usage telemetry is switched off, and Converlt has no analytics service.

## Data that stays with you

Converlt keeps these locally, on your computer or on GPU machines you connect over SSH or WSL. They aren't sent to us:

- your source code, datasets and model files
- run history: commands, settings, metrics, logs, GPU readings and notes, kept in the `.converge` folder of your project
- machine details you add (host names, SSH key paths) and the app's settings

When you start a run, Converlt copies your project's code to the GPU machine **you** chose, over your own SSH connection or WSL. When you share a run, it writes a `.converlt-run` file to a place you pick; what happens to that file is up to you.

## Converlt Cloud (only if you sign in)

If you sign in to a Converlt account, our service (the Converlt Gateway) stores:

| What | Why |
|---|---|
| Your email address and name, from your sign-in (email, Google or GitHub, through Supabase) | To identify your account |
| Access tokens, stored only as one-way hashes | To recognize the app when it calls the service |
| A credit ledger: credits added, and each charge with a short description (for example the GPU type and time, or the AI model and number of tokens) | Billing, and showing you your spending |
| Cloud GPUs you rent: the GPU type, region, disk size, price, status and its SSH address | To start, bill and stop them |
| Spending limits you set | To stop charges at the limit |

**AI requests.** When you use Converlt's AI models through your account, your messages go through our service to [OpenRouter](https://openrouter.ai), which routes them to the model's provider. Our service doesn't store the content of your messages, only the model used and the number of tokens, for billing. OpenRouter and the model provider handle the messages under their own policies.

**Cloud GPUs** are rented from [RunPod](https://www.runpod.io) on your behalf. Code and data you run on a rented GPU are on RunPod's machines, under RunPod's terms.

The service runs on [Render](https://render.com), and its database is hosted by [Supabase](https://supabase.com). Those providers process the data above on our behalf.

## Services you turn on yourself

These only happen if you use them, and the app sends data straight to them, not through us:

- **Extensions** are downloaded from [Open VSX](https://open-vsx.org).
- **Datasets and models** from Hugging Face or Kaggle are downloaded onto your own machines, using your own tokens if you add them.
- **Phone alerts** are sent to the [ntfy](https://ntfy.sh) topic you set up, with the run's name and status.
- **Your own AI keys** (for example a RunPod or OpenRouter key): requests go straight to that provider.
- **AI coding agents** you connect (such as Claude Code or Codex) can use Converlt's tools on your computer, under their own policies.

## Keeping and deleting data

Data on your computer stays until you delete it. For Converlt Cloud, ask us to delete your account and we'll delete your account, tokens and rented-GPU records. We keep the credit ledger only as long as the law requires for billing records.

## Security

Access tokens are stored as hashes and never in plain text. The service only accepts encrypted (HTTPS) connections, and its database is closed to everything except the service itself.

## Children

Converlt is a developer tool and isn't directed at children under 13.

## Changes and contact

If this policy changes, we'll update it here and change the date at the top. For questions or deletion requests, open an issue at https://github.com/Sehastrajit-S/converlt/issues.
