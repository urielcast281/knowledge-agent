/**
 * Pipeline tests that don't require any API keys.
 * Exercises: normalize → shortlist → buildSlip → buildMessage.
 *
 *   node test/pipeline.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { normalize, filterLeagues } = require('../src/prizepicks');
const { shortlist } = require('../src/model');
const { buildSlip } = require('../src/engine');
const { buildMessage } = require('../src/format');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const doc = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixture.projections.json'), 'utf8')
);

console.log('normalize:');
const lines = normalize(doc);
check('flattens JSON:API into line objects', () => {
  assert.strictEqual(lines.length, 6);
});
check('joins player + league from included', () => {
  const p1 = lines.find((l) => l.id === '101');
  assert.strictEqual(p1.player, 'Player One');
  assert.strictEqual(p1.league, 'NBA');
  assert.strictEqual(p1.team, 'LAL');
  assert.strictEqual(p1.statType, 'Points');
  assert.strictEqual(p1.line, 27.5);
});
check('reads odds_type for promos', () => {
  assert.strictEqual(lines.find((l) => l.id === '103').oddsType, 'demon');
});

console.log('filterLeagues:');
check('empty filter keeps everything', () => {
  assert.strictEqual(filterLeagues(lines, []).length, 6);
});
check('filters to requested league', () => {
  const nfl = filterLeagues(lines, ['NFL']);
  assert.strictEqual(nfl.length, 1);
  assert.strictEqual(nfl[0].player, 'Quarterback Four');
});

console.log('shortlist:');
const finalists = shortlist(lines, { finalistCount: 25, includePromos: false });
check('drops the zero-line entry', () => {
  assert.ok(!finalists.some((l) => l.id === '301'));
});
check('drops promo lines when not allowed', () => {
  assert.ok(!finalists.some((l) => l.oddsType !== 'standard'));
});
check('caps to 2 lines per player', () => {
  const byPlayer = {};
  finalists.forEach((l) => (byPlayer[l.player] = (byPlayer[l.player] || 0) + 1));
  assert.ok(Object.values(byPlayer).every((c) => c <= 2));
});
check('keeps promos when includePromos=true', () => {
  const withPromos = shortlist(lines, { finalistCount: 25, includePromos: true });
  assert.ok(withPromos.some((l) => l.oddsType === 'demon'));
});

console.log('buildSlip:');
const verdicts = [
  { player: 'Player One', statType: 'Points', line: 27.5, league: 'NBA', side: 'over', confidence: 0.72, reasoning: 'a' },
  { player: 'Player One', statType: 'Assists', line: 8.5, league: 'NBA', side: 'under', confidence: 0.66, reasoning: 'b' },
  { player: 'Player One', statType: 'Rebounds', line: 6.5, league: 'NBA', side: 'over', confidence: 0.64, reasoning: 'c' },
  { player: 'Player Two', statType: 'Points', line: 24.5, league: 'NBA', side: 'over', confidence: 0.61, reasoning: 'd' },
  { player: 'Quarterback Four', statType: 'Passing Yards', line: 275.5, league: 'NFL', side: 'under', confidence: 0.55, reasoning: 'e' },
];
const slip = buildSlip(verdicts, { minConfidence: 0.58, slipSize: 6 });
check('excludes picks below the confidence bar', () => {
  assert.ok(!slip.some((p) => p.confidence < 0.58));
  assert.ok(!slip.some((p) => p.player === 'Quarterback Four'));
});
check('caps 2 picks per player in the slip', () => {
  const c = slip.filter((p) => p.player === 'Player One').length;
  assert.strictEqual(c, 2);
});
check('ranks by confidence descending', () => {
  for (let i = 1; i < slip.length; i++) {
    assert.ok(slip[i - 1].confidence >= slip[i].confidence);
  }
});

console.log('buildMessage:');
check('renders a slip message', () => {
  const msg = buildMessage(slip, { boardSize: 6, finalistCount: finalists.length });
  assert.ok(msg.includes('Dragon Co Picks'));
  assert.ok(msg.includes('Player One'));
  assert.ok(/OVER|UNDER/.test(msg));
});
check('renders the empty-slip message', () => {
  const msg = buildMessage([], {});
  assert.ok(msg.includes('No plays today'));
});

console.log(`\n${passed} checks passed ✅`);
