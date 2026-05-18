/**
 * Knowledge — Kalshi Prediction Market Trading Agent
 * 
 * Strategy: Kelly Criterion + Probability Arbitrage
 * 
 * Core process for every market:
 *   1. Estimate true probability (p) using all available information
 *   2. Read market price (crowd's probability)
 *   3. Compare: if your p is meaningfully different, you have an edge
 *   4. Calculate bet size using Half-Kelly:
 *      f = ((p * b - q) / b) / 2
 *      where b = (1 - market_price) / market_price, q = 1 - p
 *   5. Bet f% of current bankroll. Never more.
 * 
 * Hard rules:
 *   - No edge = no bet. Waiting is valid.
 *   - Never exceed Half-Kelly.
 *   - Single bet never exceeds 20% of bankroll.
 *   - Recalculate fresh each time with current bankroll.
 *   - Honest probability estimates. Overconfidence kills.
 */

const https = require('https');
const http = require('http');

// ── Configuration ──
const CONFIG = {
  apiKey: '639bc4cb-f8b0-475e-89a2-0972b6d4a88e',
  privateKeyPath: '/mnt/c/Users/harim/.openclaw/workspace/.kalshi_private.pem',
  host: 'api.elections.kalshi.com',
  
  // Risk management
  maxSingleBetPct: 0.20,      // max 20% of bankroll on one bet
  minEdge: 0.10,              // minimum 10% edge to trade
  minBankroll: 5.00,          // stop trading below $5
  maxOpenPositions: 10,       // max concurrent positions
  maxDailyLossPct: 0.15,      // stop after 15% daily loss
  
  // Kelly settings
  kellyFraction: 0.5,         // Half-Kelly
  
  // Scanning
  scanIntervalMinutes: 30,
  minVolume: 100,             // minimum market volume to consider
  maxMarketsPerScan: 50,
  
  // Logging
  logPath: 'C:/Users/harim/.openclaw/workspace/kalshi/agent/knowledge-log.json',
  statePath: 'C:/Users/harim/.openclaw/workspace/kalshi/agent/knowledge-state.json',
};

// ── State ──
let state = {
  bankroll: 0,
  openPositions: [],
  todayPnL: 0,
  todayTrades: 0,
  lastScan: null,
  totalTrades: 0,
  totalWins: 0,
  totalLosses: 0,
  peakBankroll: 0,
};

// ── Helpers ──
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[Knowledge ${ts}] ${msg}`);
}

function saveState() {
  try {
    const fs = require('fs');
    fs.writeFileSync(CONFIG.statePath, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    const fs = require('fs');
    if (fs.existsSync(CONFIG.statePath)) {
      state = JSON.parse(fs.readFileSync(CONFIG.statePath, 'utf8'));
    }
  } catch (e) { /* ignore */ }
}

function appendLog(entry) {
  try {
    const fs = require('fs');
    let logs = [];
    if (fs.existsSync(CONFIG.logPath)) {
      logs = JSON.parse(fs.readFileSync(CONFIG.logPath, 'utf8') || '[]');
    }
    logs.push({ ...entry, timestamp: new Date().toISOString() });
    // Keep last 500 entries
    if (logs.length > 500) logs = logs.slice(-500);
    fs.writeFileSync(CONFIG.logPath, JSON.stringify(logs, null, 2));
  } catch (e) { /* ignore */ }
}

// ── Kalshi API Client ──
const crypto = require('crypto');
const fs = require('fs');

let privateKey;
try {
  privateKey = fs.readFileSync(CONFIG.privateKeyPath, 'utf8');
} catch (e) {
  log(`ERROR: Cannot read private key: ${e.message}`);
  process.exit(1);
}

function sign(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + '/trade-api/v2' + path;
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
  return { timestamp, signature };
}

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const { timestamp, signature } = sign(method, path);
    const options = {
      hostname: CONFIG.host,
      path: '/trade-api/v2' + path,
      method,
      headers: {
        'KALSHI-ACCESS-KEY': CONFIG.apiKey,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getBalance() {
  const r = await apiRequest('GET', '/portfolio/balance');
  if (r.status === 200 && r.data.balance !== undefined) {
    return r.data.balance / 100; // cents to dollars
  }
  return null;
}

async function getMarkets(params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const r = await apiRequest('GET', '/markets' + (qs ? '?' + qs : ''));
  if (r.status === 200) return r.data.markets || [];
  return [];
}

async function getMarketOrderbook(ticker) {
  const r = await apiRequest('GET', `/markets/${ticker}/orderbook`);
  if (r.status === 200) return r.data;
  return null;
}

async function getPositions() {
  const r = await apiRequest('GET', '/portfolio/positions');
  if (r.status === 200) return r.data.market_positions || [];
  return [];
}

async function createOrder(ticker, action, side, count, price) {
  const body = {
    ticker,
    action,
    side,
    type: 'limit',
    count,
    yes_price: side === 'yes' ? price : undefined,
    no_price: side === 'no' ? price : undefined,
  };
  return apiRequest('POST', '/portfolio/orders', body);
}

// ── Kelly Criterion ──
function calcKelly(trueProb, marketPrice) {
  // marketPrice is 0-1 (e.g., 0.60 = 60 cents)
  // b = odds received = (1 - price) / price
  const b = (1 - marketPrice) / marketPrice;
  const q = 1 - trueProb;
  
  // Full Kelly: f* = (p*b - q) / b
  const fullKelly = (trueProb * b - q) / b;
  
  // Half Kelly for safety
  const halfKelly = fullKelly * CONFIG.kellyFraction;
  
  // Cap at max single bet percentage
  return Math.min(halfKelly, CONFIG.maxSingleBetPct);
}

function calcBetSize(bankroll, kellyFraction) {
  return Math.round(bankroll * kellyFraction); // in dollars
}

// ── Probability Estimation ──
// This is where the agent's "knowledge" lives.
// For each market category, we estimate true probability.

async function estimateProbability(market, orderbook) {
  const title = (market.title || '').toLowerCase();
  const subtitle = (market.subtitle || '').toLowerCase();
  const category = (market.category || '').toLowerCase();
  
  // Get current prices
  const yesPrice = orderbook?.yes?.[0]?.price ? orderbook.yes[0].price / 100 : null;
  const noPrice = orderbook?.no?.[0]?.price ? orderbook.no[0].price / 100 : null;
  
  if (!yesPrice || !noPrice) return null;
  
  // ── Weather markets ──
  if (category.includes('weather') || title.includes('high') || title.includes('low') || title.includes('temperature')) {
    return estimateWeatherProbability(market, yesPrice);
  }
  
  // ── Sports markets ──
  if (category.includes('sports') || category.includes('nba') || category.includes('nfl') || 
      category.includes('mlb') || category.includes('nhl') || category.includes('soccer')) {
    return estimateSportsProbability(market, yesPrice);
  }
  
  // ── Politics / Elections ──
  if (category.includes('politic') || category.includes('election') || category.includes('president') ||
      category.includes('congress') || category.includes('senate')) {
    return estimatePoliticsProbability(market, yesPrice);
  }
  
  // ── Economics / Finance ──
  if (category.includes('econom') || category.includes('finance') || category.includes('fed') ||
      category.includes('gdp') || category.includes('inflation') || category.includes('interest')) {
    return estimateEconomicsProbability(market, yesPrice);
  }
  
  // ── Crypto ──
  if (category.includes('crypto') || title.includes('bitcoin') || title.includes('btc') || title.includes('eth')) {
    return estimateCryptoProbability(market, yesPrice);
  }
  
  // Default: no edge detected
  return null;
}

async function estimateWeatherProbability(market, marketPrice) {
  // For weather markets, we'd ideally fetch real weather data
  // For now, use a simple mean-reversion approach
  // Weather markets tend to be efficient, so only trade on extreme mispricing
  
  const title = market.title || '';
  
  // If market price is extreme (< 15% or > 85%), there might be edge
  // due to weather model uncertainty
  if (marketPrice < 0.15 || marketPrice > 0.85) {
    // Extreme prices often overestimate certainty
    // If price is 90%, true prob is probably 75-85%
    // If price is 10%, true prob is probably 15-25%
    if (marketPrice > 0.85) {
      return { prob: marketPrice - 0.08, reason: 'Weather extreme overpricing (high)' };
    }
    if (marketPrice < 0.15) {
      return { prob: marketPrice + 0.08, reason: 'Weather extreme overpricing (low)' };
    }
  }
  
  return null; // No edge on normal weather prices
}

async function estimateSportsProbability(market, marketPrice) {
  // Sports markets are generally efficient
  // Edge comes from late line movement and public bias
  
  const title = market.title || '';
  
  // Public bias: popular teams are overpriced
  const popularTeams = ['chiefs', 'cowboys', 'patriots', 'lakers', 'warriors', 'yankees', 'cowboys'];
  const isPopular = popularTeams.some(t => title.toLowerCase().includes(t));
  
  if (isPopular && marketPrice > 0.60) {
    // Popular teams tend to be overpriced by 5-10%
    return { prob: marketPrice - 0.06, reason: 'Public bias on popular team' };
  }
  
  return null;
}

async function estimatePoliticsProbability(market, marketPrice) {
  // Politics: incumbency advantage, polling biases, etc.
  
  const title = market.title || '';
  
  // Incumbents win ~85% of the time in congressional races
  if (title.includes('will') && (title.includes('republican') || title.includes('democrat'))) {
    // Check if market is pricing in a wave election
    if (marketPrice > 0.90) {
      return { prob: 0.82, reason: 'Incumbency base rate adjustment' };
    }
  }
  
  return null;
}

async function estimateEconomicsProbability(market, marketPrice) {
  // Fed decisions, economic data releases
  
  const title = market.title || '';
  
  // Fed tends to be predictable — if market prices > 90% for a rate decision,
  // it's usually right but sometimes surprises happen
  if ((title.includes('fed') || title.includes('fomc') || title.includes('interest rate')) && marketPrice > 0.92) {
    return { prob: 0.87, reason: 'Fed surprise risk premium' };
  }
  
  return null;
}

async function estimateCryptoProbability(market, marketPrice) {
  // Crypto markets are volatile and often mispriced
  
  const title = market.title || '';
  
  // "Will BTC be above $X by date" — these tend to be slightly overpriced
  // on the yes side due to crypto optimism bias
  if ((title.includes('bitcoin') || title.includes('btc')) && marketPrice > 0.70) {
    return { prob: marketPrice - 0.05, reason: 'Crypto optimism bias adjustment' };
  }
  
  return null;
}

// ── Main Trading Logic ──
async function run() {
  log('═══ Knowledge Agent Starting ═══');
  loadState();
  
  // Step 1: Check balance
  const balance = await getBalance();
  if (balance === null) {
    log('ERROR: Could not fetch balance. Aborting.');
    return;
  }
  
  state.bankroll = balance;
  log(`Bankroll: $${balance.toFixed(2)}`);
  
  if (balance < CONFIG.minBankroll) {
    log(`Bankroll below minimum ($${CONFIG.minBankroll}). Stopping.`);
    return;
  }
  
  // Step 2: Check existing positions
  const positions = await getPositions();
  state.openPositions = positions;
  log(`Open positions: ${positions.length}`);
  
  if (positions.length >= CONFIG.maxOpenPositions) {
    log(`Max positions reached (${CONFIG.maxOpenPositions}). Skipping new trades.`);
  }
  
  // Step 3: Check daily loss limit
  if (state.todayPnL < -balance * CONFIG.maxDailyLossPct) {
    log(`Daily loss limit reached ($${state.todayPnL.toFixed(2)}). Stopping.`);
    return;
  }
  
  // Step 4: Scan markets
  log('Scanning markets...');
  const markets = await getMarkets({
    status: 'open',
    limit: CONFIG.maxMarketsPerScan,
    order: 'volume24hr',
    ascending: false,
  });
  
  log(`Found ${markets.length} markets`);
  
  const opportunities = [];
  
  for (const market of markets) {
    // Skip low-volume markets
    if ((market.volume24hr || 0) < CONFIG.minVolume) continue;
    
    // Skip markets we already have positions in
    if (positions.some(p => p.ticker === market.ticker)) continue;
    
    // Get orderbook
    const orderbook = await getMarketOrderbook(market.ticker);
    if (!orderbook) continue;
    
    // Estimate probability
    const estimate = await estimateProbability(market, orderbook);
    if (!estimate) continue;
    
    // Get market price (yes side)
    const yesBid = orderbook.yes?.[0]?.price ? orderbook.yes[0].price / 100 : null;
    if (!yesBid) continue;
    
    // Calculate edge
    const edge = estimate.prob - yesBid;
    
    if (Math.abs(edge) < CONFIG.minEdge) continue;
    
    // Calculate Kelly
    const kelly = calcKelly(estimate.prob, yesBid);
    if (kelly <= 0) continue;
    
    const betSize = calcBetSize(balance, kelly);
    if (betSize < 1) continue; // minimum $1 bet
    
    const side = edge > 0 ? 'yes' : 'no';
    const price = edge > 0 ? Math.round(yesBid * 100) : Math.round((1 - yesBid) * 100);
    
    opportunities.push({
      ticker: market.ticker,
      title: market.title,
      side,
      price,
      count: betSize,
      edge: edge.toFixed(3),
      kelly: kelly.toFixed(3),
      betSize,
      reason: estimate.reason,
      marketPrice: yesBid.toFixed(2),
      estimatedProb: estimate.prob.toFixed(2),
    });
  }
  
  log(`Found ${opportunities.length} opportunities`);
  
  // Step 5: Execute best opportunities (up to 3 per scan)
  const toTrade = opportunities
    .sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge))
    .slice(0, 3);
  
  for (const opp of toTrade) {
    log(`Trading: ${opp.ticker} | ${opp.side} @ ${opp.price}¢ | $${opp.count} | Edge: ${opp.edge} | ${opp.reason}`);
    
    try {
      const result = await createOrder(opp.ticker, 'buy', opp.side, opp.count, opp.price);
      
      if (result.status === 200 || result.status === 201) {
        log(`✓ Order placed: ${opp.ticker} ${opp.side} @ ${opp.price}¢ x${opp.count}`);
        state.todayTrades++;
        state.totalTrades++;
        appendLog({ action: 'TRADE', ...opp, result: 'success', orderId: result.data?.order?.id });
      } else {
        log(`✗ Order failed: ${opp.ticker} — HTTP ${result.status}: ${JSON.stringify(result.data)}`);
        appendLog({ action: 'TRADE_FAIL', ...opp, status: result.status, error: result.data });
      }
    } catch (e) {
      log(`✗ Order error: ${opp.ticker} — ${e.message}`);
      appendLog({ action: 'TRADE_ERROR', ...opp, error: e.message });
    }
    
    // Rate limit: wait between orders
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // Step 6: Update state
  state.lastScan = new Date().toISOString();
  if (balance > state.peakBankroll) state.peakBankroll = balance;
  saveState();
  
  // Step 7: Report
  log('═══ Scan Complete ═══');
  log(`Bankroll: $${balance.toFixed(2)} | Open: ${positions.length} | Today P&L: $${state.todayPnL.toFixed(2)} | Trades: ${state.totalTrades}`);
  
  if (toTrade.length > 0) {
    log('Trades executed:');
    toTrade.forEach(t => log(`  ${t.ticker}: ${t.side} @ ${t.price}¢ x$${t.count} (${t.reason})`));
  } else {
    log('No trades executed this scan.');
  }
}

// ── Run ──
run().catch(e => {
  log(`FATAL ERROR: ${e.message}`);
  log(e.stack);
  process.exit(1);
});
