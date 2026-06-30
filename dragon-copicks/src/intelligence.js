/**
 * The intelligence — Claude reasons over the finalist lines and picks plays.
 *
 * Hybrid flow:
 *   model.js has already narrowed the board to a shortlist. Here Claude (Opus
 *   4.8 by default) evaluates each finalist, optionally using the web_search
 *   server tool to check recent form and injury news, and returns a structured
 *   verdict per line: over/under lean, a calibrated confidence, and a one-line
 *   rationale. The engine ranks those and builds the slip.
 *
 * Two passes when web search is enabled (keeps the tool loop and the strict
 * JSON output cleanly separated):
 *   1. Research pass — Claude searches and writes a freeform assessment.
 *   2. Structuring pass — that assessment is distilled into strict JSON.
 * With web search disabled it's a single structured-output call.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const SYSTEM_PROMPT = `You are the analyst behind "Dragon Co Picks", a PrizePicks pick'em service.
For each player projection you are given, decide whether the player will go OVER or UNDER the posted line, and how confident you are.

Think like a sharp bettor, not a fan:
- Weigh recent form, role/usage, pace and matchup, injuries to the player and teammates, and whether the line looks soft or sharp.
- A PrizePicks line is roughly the market's median expectation. Only express high confidence when you have a real, specific reason the line is mispriced.
- Calibrate honestly. Confidence is your estimated probability the pick hits: 0.5 is a coin flip, 0.6 is a lean, 0.7+ is a strong, well-supported read. Most lines deserve 0.5–0.62. Reserve 0.7+ for genuine edges.
- Prefer standard lines. Be skeptical of chasing big numbers.
- No edge is a valid answer — say so with a confidence near 0.5.`;

const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'The line id, copied exactly from the input.' },
          player: { type: 'string' },
          statType: { type: 'string' },
          line: { type: 'number' },
          league: { type: 'string' },
          side: { type: 'string', enum: ['over', 'under'] },
          confidence: {
            type: 'number',
            description: 'Estimated probability (0-1) the pick hits.',
          },
          reasoning: {
            type: 'string',
            description: 'One concise sentence justifying the pick.',
          },
        },
        required: ['id', 'player', 'statType', 'line', 'league', 'side', 'confidence', 'reasoning'],
      },
    },
  },
  required: ['picks'],
};

/** Compact, token-cheap rendering of the finalist board for the prompt. */
function renderLines(lines) {
  return lines
    .map((l) => {
      const when = l.startTime ? new Date(l.startTime).toISOString() : 'TBD';
      const promo = l.oddsType && l.oddsType !== 'standard' ? ` [${l.oddsType}]` : '';
      return `- id=${l.id} | ${l.player} (${l.team || '?'}, ${l.league}) ${l.statType} ${l.line}${promo} | ${l.opponent || ''} | ${when}`;
    })
    .join('\n');
}

/** Pass 1: let Claude search the web and write a freeform assessment. */
async function researchPass(client, lines) {
  const userPrompt =
    `Today's PrizePicks board (finalists already filtered):\n\n${renderLines(lines)}\n\n` +
    `Research these as needed (recent games, injury reports, starting status, matchup) ` +
    `and write a brief assessment of each: your over/under lean, rough confidence, and why. ` +
    `Be concise — a line or two per player.`;

  const messages = [{ role: 'user', content: userPrompt }];
  let response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.anthropic.effort },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 20 }],
    system: SYSTEM_PROMPT,
    messages,
  });

  // Server-tool loop: resume on pause_turn until the model finishes.
  let guard = 0;
  while (response.stop_reason === 'pause_turn' && guard < 6) {
    messages.push({ role: 'assistant', content: response.content });
    response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: config.anthropic.effort },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 20 }],
      system: SYSTEM_PROMPT,
      messages,
    });
    guard += 1;
  }

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Extract the `picks` array from a structured-output response. */
function parsePicks(response) {
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`Claude did not return valid JSON: ${text.slice(0, 300)}`);
  }
  return Array.isArray(obj.picks) ? obj.picks : [];
}

/** Pass 2 (or the only pass): produce strict JSON picks. */
async function structurePass(client, lines, assessment) {
  const board = renderLines(lines);
  const userPrompt = assessment
    ? `Here is your own research assessment of today's board:\n\n${assessment}\n\n` +
      `Now output your final structured verdict for EVERY line below. Copy each id exactly.\n\n${board}`
    : `Evaluate every line below and output your structured verdict for each. Copy each id exactly.\n\n${board}`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: config.anthropic.effort,
      format: { type: 'json_schema', name: 'dragon_picks', schema: PICK_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return parsePicks(response);
}

/**
 * Evaluate the finalist lines and return an array of verdicts:
 *   { id, player, statType, line, league, side, confidence, reasoning }
 */
async function evaluate(lines) {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot run the intelligence pass.');
  }
  if (lines.length === 0) return [];

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  let assessment = '';
  if (config.anthropic.webSearch) {
    try {
      assessment = await researchPass(client, lines);
    } catch (e) {
      // Web research is best-effort; fall back to knowledge-only.
      console.warn(`[dragon] web research pass failed, continuing without it: ${e.message}`);
      assessment = '';
    }
  }

  const picks = await structurePass(client, lines, assessment);

  // Keep only verdicts that map back to a real finalist line, and merge in the
  // canonical line fields so downstream code trusts our data, not the model's.
  const byId = new Map(lines.map((l) => [String(l.id), l]));
  return picks
    .map((p) => {
      const src = byId.get(String(p.id));
      if (!src) return null;
      return {
        ...src,
        side: p.side === 'under' ? 'under' : 'over',
        confidence: clamp01(p.confidence),
        reasoning: (p.reasoning || '').trim(),
      };
    })
    .filter(Boolean);
}

function clamp01(n) {
  const x = typeof n === 'number' ? n : parseFloat(n);
  if (Number.isNaN(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

module.exports = { evaluate, renderLines, PICK_SCHEMA };
