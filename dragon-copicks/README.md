# 🐉 Dragon Co Picks

A Telegram bot that generates daily **PrizePicks** plays. It pulls the day's
projection board, uses **Claude** (the "intelligence") to reason over the best
lines — recent form, matchup, role, injuries — and posts a ranked slip to your
channel.

It's a **hybrid** engine:

1. **Fetch** — pull the day's PrizePicks projections.
2. **Pre-filter** (`src/model.js`) — a cheap statistical pass cleans the board,
   drops promos/stale/invalid lines, and ranks a shortlist of finalists so we
   only spend Claude tokens where it matters.
3. **Reason** (`src/intelligence.js`) — Claude evaluates each finalist (optionally
   using web search for current news), and returns an over/under lean, a
   calibrated confidence, and a one-line rationale per line.
4. **Build the slip** (`src/engine.js`) — rank by confidence, enforce the
   confidence floor, diversify per player, take the top N.
5. **Post** (`src/telegram.js`) — send the formatted slip to your channel.

## Quick start

```bash
cd dragon-copicks
npm install
npx playwright install chromium      # only needed for live PrizePicks fetch
cp .env.example .env                 # then fill in your tokens
npm run dry-run                      # builds + prints the slip, doesn't post
npm start                            # builds + posts to Telegram
```

### What you need

| Secret | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Create a bot via [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_CHAT_ID` | Add the bot to your channel **as an admin**. Use `@yourchannel` (public) or the numeric `-100…` id (private). |
| `ANTHROPIC_API_KEY` | [platform.claude.com](https://platform.claude.com) → API keys. |

All config is environment-driven — see `.env.example` for every knob
(`DRAGON_LEAGUES`, `DRAGON_SLIP_SIZE`, `DRAGON_MIN_CONFIDENCE`, etc.). Nothing
sensitive is committed.

## ⚠️ About fetching PrizePicks

PrizePicks has **no official API** and protects its endpoints with **PerimeterX**
bot detection. A plain HTTP request gets a `403` captcha challenge, so this
project drives a real headless Chromium (Playwright) to load the app, let the
anti-bot cookie get issued, and fetch the JSON from inside the page.

That works reliably from a **residential IP** (your own computer). It does **not**
reliably work from datacenter / CI IP ranges (GitHub Actions, most cloud VMs) —
PerimeterX challenges those aggressively. You have three options:

- **Run it on your own machine** (recommended) — residential IP, real browser. See cron below.
- **Use a fixture** — save a `projections` JSON once and point `DRAGON_FIXTURE`
  at it (no network). Good for testing or pairing with your own data feed.
- **Run in CI anyway** — the included GitHub Action will try, but expect the
  fetch to be blocked from Actions IPs. Treat it as best-effort.

The intelligence and Telegram steps work anywhere — only the PrizePicks scrape is
IP-sensitive.

## Running it daily

### On your own machine (cron)

```cron
# 10:00 every day — adjust path and time to your slate
0 10 * * *  cd /path/to/dragon-copicks && /usr/bin/node run-daily.js >> logs/cron.log 2>&1
```

(Put your secrets in `.env` next to `run-daily.js`; it's loaded automatically.)

### GitHub Actions

`.github/workflows/daily-picks.yml` runs on a daily cron and on manual dispatch.
Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `ANTHROPIC_API_KEY` as repo
**secrets**. Note the IP caveat above.

## How the "intelligence" works

`src/intelligence.js` sends the finalist board to Claude (`claude-opus-4-8` by
default) with a sharp-bettor system prompt. With `DRAGON_WEB_SEARCH=1` (default)
it first lets Claude use the web-search tool to check recent games, injuries, and
starting status, then distills everything into a strict JSON verdict per line via
structured outputs. Confidence is treated as the model's estimated hit
probability and is calibrated to stay honest — most lines land 0.50–0.62, and
only genuine edges clear the `DRAGON_MIN_CONFIDENCE` bar onto the slip.

Set `DRAGON_WEB_SEARCH=0` to run knowledge-only (cheaper, but blind to today's
news).

## Tests

```bash
npm test     # normalize → shortlist → buildSlip → format, no API keys needed
```

## Layout

```
config.js              env-driven config (secrets never committed)
run-daily.js           entrypoint: run pipeline, post to Telegram
src/prizepicks.js      fetch + normalize the projection board
src/model.js           statistical pre-filter / shortlist
src/intelligence.js    Claude reasoning → structured verdicts
src/engine.js          orchestration: fetch → filter → reason → slip
src/format.js          Telegram message rendering
src/telegram.js        Telegram Bot API client
test/                  fixture + pipeline tests
```

## Disclaimer

For entertainment. This is not betting advice and nothing is guaranteed. Bet
responsibly and only where legal.
