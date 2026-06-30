#!/usr/bin/env node
/**
 * Dragon Co Picks — daily entrypoint.
 *
 * Runs the pipeline and posts today's slip to the Telegram channel.
 * Schedule this once a day (cron / GitHub Actions), or run it on demand.
 *
 *   node run-daily.js
 *
 * Honors DRAGON_DRY_RUN=1 to build + print the slip without posting.
 */

// Load a local .env if present (no dependency — tiny parser).
loadDotEnv();

const config = require('./config');
const { run } = require('./src/engine');
const { buildMessage } = require('./src/format');
const { sendMessage } = require('./src/telegram');

async function main() {
  console.log('[dragon] starting daily run…');
  const { slip, meta } = await run();
  console.log(`[dragon] board=${meta.boardSize} finalists=${meta.finalistCount} slip=${slip.length}`);

  const message = buildMessage(slip, meta);
  console.log('\n--- message ---\n' + message + '\n---------------\n');

  if (config.dryRun) {
    console.log('[dragon] DRY RUN — not posting to Telegram.');
    return;
  }

  await sendMessage(message);
  console.log('[dragon] posted to Telegram ✅');
}

function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

main().catch((err) => {
  console.error(`[dragon] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
