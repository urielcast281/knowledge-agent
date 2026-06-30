/**
 * Render a slip of picks into a Telegram message (HTML parse mode).
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function arrow(side) {
  return side === 'under' ? '🔻 UNDER' : '🔺 OVER';
}

function pct(conf) {
  return `${Math.round(conf * 100)}%`;
}

function todayStr() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * @param {Array} slip   chosen picks (already ranked)
 * @param {object} meta  { boardSize, finalistCount }
 */
function buildMessage(slip, meta = {}) {
  const lines = [];
  lines.push(`🐉 <b>Dragon Co Picks</b> — ${esc(todayStr())}`);
  lines.push('');

  if (slip.length === 0) {
    lines.push('No plays today — nothing on the board cleared the confidence bar.');
    lines.push('Discipline is a pick too. 🐉');
    return lines.join('\n');
  }

  lines.push(`Today's slip — <b>${slip.length}</b> plays:`);
  lines.push('');

  slip.forEach((p, i) => {
    lines.push(
      `<b>${i + 1}. ${esc(p.player)}</b> — ${esc(p.statType)} ${esc(p.line)}`
    );
    lines.push(
      `   ${arrow(p.side)}  ·  ${esc(p.league)}${p.opponent ? '  ·  ' + esc(p.opponent) : ''}  ·  conf ${pct(p.confidence)}`
    );
    if (p.reasoning) lines.push(`   <i>${esc(p.reasoning)}</i>`);
    lines.push('');
  });

  if (meta.boardSize) {
    lines.push(
      `<i>Scanned ${esc(meta.boardSize)} lines → ${esc(meta.finalistCount || '?')} finalists → ${slip.length} picks.</i>`
    );
  }
  lines.push('⚠️ <i>For entertainment. Bet responsibly; nothing is guaranteed.</i>');

  return lines.join('\n').trim();
}

module.exports = { buildMessage };
