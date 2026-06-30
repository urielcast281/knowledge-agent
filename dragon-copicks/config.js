/**
 * Dragon Co Picks — configuration
 *
 * All secrets come from environment variables. Nothing sensitive is committed.
 * Copy .env.example to .env and fill it in (run-daily.js loads .env if present),
 * or set these in your shell / GitHub Actions secrets.
 */

const path = require('path');

function envInt(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function envFloat(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isNaN(n) ? def : n;
}

module.exports = {
  // ── Telegram ──
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    // Channel/chat id. For a public channel you can use "@dragoncopicks";
    // for a private channel use the numeric id (e.g. -1001234567890).
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // ── Claude (the "intelligence") ──
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    // Model used to reason over the finalist lines. Opus 4.8 is the default.
    model: process.env.DRAGON_MODEL || 'claude-opus-4-8',
    // Effort for the reasoning pass: low | medium | high | xhigh | max
    effort: process.env.DRAGON_EFFORT || 'high',
    // Let Claude use the web_search server tool to check recent form / injuries
    // before calling each line. On by default; set DRAGON_WEB_SEARCH=0 to rely
    // on the model's own knowledge only (cheaper, but blind to today's news).
    webSearch: process.env.DRAGON_WEB_SEARCH !== '0',
  },

  // ── PrizePicks fetch ──
  prizepicks: {
    // Leagues to include. Empty array = all leagues PrizePicks offers today.
    // Names are matched case-insensitively against the league name
    // (e.g. "NBA", "NFL", "MLB", "WNBA", "NHL", "MLS", "CS2", "VAL").
    leagues: (process.env.DRAGON_LEAGUES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Read projections from a local JSON file instead of hitting the network.
    // Useful for testing, or for running where PrizePicks blocks datacenter IPs.
    // Accepts either the raw PrizePicks JSON:API payload or a pre-normalized array.
    fixturePath: process.env.DRAGON_FIXTURE || '',
    // How long to let the headless browser warm up the anti-bot cookie (ms).
    warmupMs: envInt('DRAGON_WARMUP_MS', 6000),
    // Chromium executable. Defaults to the Playwright-managed build if present.
    chromiumPath: process.env.DRAGON_CHROMIUM_PATH || '',
  },

  // ── Pick engine ──
  engine: {
    // How many lines to hand to Claude after the statistical pre-filter.
    finalistCount: envInt('DRAGON_FINALISTS', 25),
    // How many picks to put on the slip that gets posted.
    slipSize: envInt('DRAGON_SLIP_SIZE', 6),
    // Minimum confidence (0-1) Claude must assign for a pick to be eligible.
    minConfidence: envFloat('DRAGON_MIN_CONFIDENCE', 0.58),
    // Drop "demon"/"goblin" promo lines (different payout math) unless allowed.
    includePromos: process.env.DRAGON_INCLUDE_PROMOS === '1',
  },

  // ── Output ──
  // Where to drop a JSON record of each run (for history / debugging).
  logDir: process.env.DRAGON_LOG_DIR || path.join(__dirname, 'logs'),

  // If set to '1', build the slip and print/log it but do NOT post to Telegram.
  dryRun: process.env.DRAGON_DRY_RUN === '1',
};
