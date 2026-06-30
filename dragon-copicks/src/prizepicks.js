/**
 * PrizePicks projection fetcher + normalizer.
 *
 * PrizePicks has no official API. The public endpoint
 *   https://api.prizepicks.com/projections
 * returns a JSON:API document, but it sits behind PerimeterX bot protection,
 * so a plain HTTP GET from a datacenter IP gets a 403 captcha challenge.
 *
 * Strategy:
 *   1. If a fixture file is configured, read projections from disk (no network).
 *   2. Otherwise drive a real Chromium (Playwright) to load the app, let the
 *      anti-bot cookie get issued, then fetch the JSON from inside the page.
 *
 * The browser path works from a residential IP (e.g. your own machine). From
 * locked-down datacenter / CI IPs PerimeterX may still challenge — in that case
 * use a fixture, or run the daily job somewhere with a clean IP.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const PROJECTIONS_URL =
  'https://api.prizepicks.com/projections?per_page=250&single_stat=true&game_mode=pickem';
const APP_URL = 'https://app.prizepicks.com/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Locate a usable Chromium executable. */
function resolveChromium() {
  if (config.prizepicks.chromiumPath) return config.prizepicks.chromiumPath;
  // Common Playwright-managed locations.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-'));
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  } catch (_) {
    /* fall through to Playwright's own resolution */
  }
  return undefined; // let Playwright pick its default
}

/** Fetch the raw JSON:API document via a headless browser. */
async function fetchViaBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    throw new Error(
      'playwright is not installed. Run `npm install` in dragon-copicks, ' +
        'or set DRAGON_FIXTURE to a saved projections JSON file.'
    );
  }

  const launchOpts = {
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  };
  const exe = resolveChromium();
  if (exe) launchOpts.executablePath = exe;
  // Route through an outbound proxy when one is configured (e.g. CI sandboxes).
  if (process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY };

  const browser = await chromium.launch(launchOpts);
  try {
    const ctx = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(config.prizepicks.warmupMs);

    const result = await page.evaluate(async (url) => {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      return { status: r.status, body: await r.text() };
    }, PROJECTIONS_URL);

    if (result.status !== 200) {
      throw new Error(
        `PrizePicks returned HTTP ${result.status} (likely a bot challenge). ` +
          'Run from a residential IP or supply DRAGON_FIXTURE.'
      );
    }
    return JSON.parse(result.body);
  } finally {
    await browser.close();
  }
}

/** Read the raw JSON:API document (or a pre-normalized array) from disk. */
function readFixture(fixturePath) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  return raw;
}

/**
 * Turn a PrizePicks JSON:API document into a flat array of line objects:
 *   { id, player, team, position, league, statType, line, oddsType,
 *     startTime, opponent }
 *
 * If given an already-flat array, it's returned as-is.
 */
function normalize(doc) {
  if (Array.isArray(doc)) return doc; // already normalized
  if (!doc || !Array.isArray(doc.data)) return [];

  // Index the `included` side-loaded resources by type+id.
  const included = {};
  for (const inc of doc.included || []) {
    included[`${inc.type}:${inc.id}`] = inc;
  }

  const lines = [];
  for (const proj of doc.data) {
    const attr = proj.attributes || {};
    const rel = proj.relationships || {};

    const playerRef = rel.new_player && rel.new_player.data;
    const player = playerRef ? included[`${playerRef.type}:${playerRef.id}`] : null;
    const pAttr = (player && player.attributes) || {};

    const leagueRef = rel.league && rel.league.data;
    const league = leagueRef ? included[`${leagueRef.type}:${leagueRef.id}`] : null;
    const leagueName =
      (league && league.attributes && league.attributes.name) ||
      pAttr.league ||
      'Unknown';

    lines.push({
      id: proj.id,
      player: pAttr.display_name || pAttr.name || 'Unknown',
      team: pAttr.team || pAttr.team_name || '',
      position: pAttr.position || '',
      league: leagueName,
      statType: attr.stat_type || attr.stat_display_name || '',
      line: typeof attr.line_score === 'number' ? attr.line_score : parseFloat(attr.line_score),
      oddsType: attr.odds_type || 'standard', // standard | demon | goblin
      startTime: attr.start_time || '',
      // PrizePicks puts the matchup in `description` (e.g. "vs LAL").
      opponent: attr.description || '',
      rank: typeof attr.rank === 'number' ? attr.rank : null,
    });
  }
  return lines;
}

/** Filter to the configured leagues (empty config = keep all). */
function filterLeagues(lines, leagues) {
  if (!leagues || leagues.length === 0) return lines;
  const wanted = leagues.map((l) => l.toLowerCase());
  return lines.filter((l) => wanted.includes((l.league || '').toLowerCase()));
}

/**
 * Top-level: return a normalized, league-filtered array of lines for today.
 */
async function getProjections() {
  let doc;
  if (config.prizepicks.fixturePath) {
    doc = readFixture(config.prizepicks.fixturePath);
  } else {
    doc = await fetchViaBrowser();
  }
  const lines = normalize(doc);
  return filterLeagues(lines, config.prizepicks.leagues);
}

module.exports = { getProjections, normalize, filterLeagues };
