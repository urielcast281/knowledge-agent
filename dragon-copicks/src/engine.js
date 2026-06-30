/**
 * Dragon Co Picks — daily pipeline orchestrator.
 *
 *   fetch board → pre-filter shortlist → Claude evaluates → rank → build slip
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getProjections } = require('./prizepicks');
const { shortlist } = require('./model');
const { evaluate } = require('./intelligence');

/** Rank verdicts and take the top N that clear the confidence bar. */
function buildSlip(verdicts, opts) {
  const eligible = verdicts
    .filter((v) => v.confidence >= opts.minConfidence)
    .sort((a, b) => b.confidence - a.confidence);

  // Diversify the slip: at most 2 picks per player.
  const perPlayer = new Map();
  const slip = [];
  for (const v of eligible) {
    const c = perPlayer.get(v.player) || 0;
    if (c >= 2) continue;
    perPlayer.set(v.player, c + 1);
    slip.push(v);
    if (slip.length >= opts.slipSize) break;
  }
  return slip;
}

function writeLog(record) {
  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    const file = path.join(config.logDir, `picks-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return file;
  } catch (e) {
    console.warn(`[dragon] could not write log: ${e.message}`);
    return null;
  }
}

/**
 * Run the full pipeline. Returns { slip, verdicts, meta }.
 */
async function run() {
  const board = await getProjections();
  if (board.length === 0) {
    return { slip: [], verdicts: [], meta: { boardSize: 0, finalistCount: 0 } };
  }

  const finalists = shortlist(board, {
    finalistCount: config.engine.finalistCount,
    includePromos: config.engine.includePromos,
  });

  const verdicts = await evaluate(finalists);

  const slip = buildSlip(verdicts, {
    minConfidence: config.engine.minConfidence,
    slipSize: config.engine.slipSize,
  });

  const meta = { boardSize: board.length, finalistCount: finalists.length };

  writeLog({
    generatedAt: new Date().toISOString(),
    meta,
    slip,
    allVerdicts: verdicts,
  });

  return { slip, verdicts, meta };
}

module.exports = { run, buildSlip };
