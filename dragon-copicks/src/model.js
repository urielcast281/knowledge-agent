/**
 * Statistical pre-filter (the cheap half of the hybrid).
 *
 * PrizePicks' projection payload doesn't ship historical box-score data, so this
 * stage is deliberately a *candidate scorer*, not a projection engine: it cleans
 * the board, drops lines that aren't worth reasoning about, and ranks the rest so
 * we only spend Claude tokens on a sensible shortlist. The actual over/under edge
 * call happens in intelligence.js.
 */

// Stat types that tend to be the most predictable / liquid markets, by league.
// Lines matching these get a scoring bump. Anything not listed still competes.
const PREFERRED_STATS = [
  'points',
  'rebounds',
  'assists',
  'pts+rebs+asts',
  'pts+rebs',
  'pts+asts',
  'rebs+asts',
  '3-pt made',
  'fantasy score',
  'passing yards',
  'rushing yards',
  'receiving yards',
  'receptions',
  'pass tds',
  'pass completions',
  'pass attempts',
  'total bases',
  'hits',
  'strikeouts',
  'hits+runs+rbis',
  'shots on goal',
  'goals',
  'saves',
  'kills', // esports
  'headshots',
];

function statScore(statType) {
  const s = (statType || '').toLowerCase();
  return PREFERRED_STATS.some((p) => s.includes(p)) ? 1 : 0;
}

/** Hours until the line's game starts (or null if unknown / already started). */
function hoursUntil(startTime) {
  if (!startTime) return null;
  const t = new Date(startTime).getTime();
  if (Number.isNaN(t)) return null;
  return (t - Date.now()) / 3_600_000;
}

/**
 * Score a single line for "worth reasoning about". Higher is better.
 * Pure heuristic — readability over cleverness.
 */
function score(line) {
  let s = 0;

  // Standard lines are the bread and butter; promos have skewed payouts.
  if (line.oddsType === 'standard') s += 2;

  // Preferred, liquid stat markets.
  s += statScore(line.statType) * 2;

  // Featured / highly-ranked lines (PrizePicks surfaces these first).
  if (line.rank != null) s += Math.max(0, 2 - line.rank / 25);

  // Prefer games that haven't started and tip off within ~36h.
  const h = hoursUntil(line.startTime);
  if (h != null) {
    if (h < 0) s -= 5; // already underway/finished — skip
    else if (h <= 36) s += 1;
  }

  // A real, positive line number.
  if (typeof line.line === 'number' && line.line > 0) s += 1;
  else s -= 5;

  return s;
}

/**
 * Reduce the full board to a ranked shortlist of finalist lines.
 *
 * @param {Array} lines     normalized PrizePicks lines
 * @param {object} opts      { finalistCount, includePromos }
 */
function shortlist(lines, opts = {}) {
  const finalistCount = opts.finalistCount || 25;
  const includePromos = !!opts.includePromos;

  // 1. Basic validity + promo gate.
  let pool = lines.filter((l) => {
    if (!l.player || l.player === 'Unknown') return false;
    if (typeof l.line !== 'number' || Number.isNaN(l.line) || l.line <= 0) return false;
    if (!includePromos && l.oddsType !== 'standard') return false;
    return true;
  });

  // 2. Deduplicate to one line per (player, statType) — keep the standard one.
  const seen = new Map();
  for (const l of pool) {
    const key = `${l.player}|${l.statType}`.toLowerCase();
    const prev = seen.get(key);
    if (!prev || (prev.oddsType !== 'standard' && l.oddsType === 'standard')) {
      seen.set(key, l);
    }
  }
  pool = [...seen.values()];

  // 3. Score and sort.
  const scored = pool
    .map((l) => ({ line: l, _s: score(l) }))
    .sort((a, b) => b._s - a._s);

  // 4. Diversify: cap how many finalists come from any single player so the
  //    shortlist isn't six props on one superstar.
  const perPlayer = new Map();
  const finalists = [];
  for (const { line } of scored) {
    const count = perPlayer.get(line.player) || 0;
    if (count >= 2) continue;
    perPlayer.set(line.player, count + 1);
    finalists.push(line);
    if (finalists.length >= finalistCount) break;
  }
  return finalists;
}

module.exports = { shortlist, score, hoursUntil };
