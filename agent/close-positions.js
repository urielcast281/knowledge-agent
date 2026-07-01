#!/usr/bin/env node
/**
 * Knowledge — Flatten / Panic-Close
 *
 * Gets you completely OUT of Kalshi:
 *   1. Cancels every resting (unfilled) order so nothing new fills mid-exit.
 *   2. Sells every open position back to the market at a marketable limit
 *      price (crosses to the current bid, so it fills immediately).
 *
 * SAFETY: dry-run by default. It prints exactly what it WOULD do and touches
 * nothing. Add --live to actually cancel orders and sell positions.
 *
 *   node close-positions.js            # preview (safe)
 *   node close-positions.js --live     # actually flatten everything
 *
 * Options:
 *   --live        execute for real (otherwise dry-run)
 *   --ticker=XYZ  only act on a single market ticker
 *   --edge=N      price N cents inside the bid for a faster fill (default 0)
 */

const crypto = require('crypto');
const api = require('./kalshi-api');

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const ONLY_TICKER = (argv.find((a) => a.startsWith('--ticker=')) || '').split('=')[1] || null;
const EDGE = parseInt((argv.find((a) => a.startsWith('--edge=')) || '').split('=')[1] || '0', 10) || 0;

function log(msg) {
  console.log(`[flatten] ${msg}`);
}

const clampPrice = (p) => Math.max(1, Math.min(99, Math.round(p)));

function unwrap(resp, key) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  return resp[key] || [];
}

/** Step 1 — cancel all resting orders. */
async function cancelRestingOrders() {
  const resting = unwrap(await api.getOrders({ status: 'resting' }), 'orders').filter(
    (o) => !ONLY_TICKER || o.ticker === ONLY_TICKER
  );

  if (resting.length === 0) {
    log('No resting orders to cancel.');
    return 0;
  }

  log(`Found ${resting.length} resting order(s) to cancel:`);
  let cancelled = 0;
  for (const o of resting) {
    const id = o.order_id || o.id;
    const desc = `${o.ticker} ${o.action} ${o.side} x${o.remaining_count ?? o.count ?? '?'} @ ${o.yes_price ?? o.no_price ?? '?'}¢ (${id})`;
    if (!LIVE) {
      log(`  would cancel: ${desc}`);
      continue;
    }
    try {
      await api.cancelOrder(id);
      log(`  ✓ cancelled: ${desc}`);
      cancelled++;
    } catch (e) {
      log(`  ✗ cancel failed: ${desc} — ${e.message}`);
    }
    await sleep(250);
  }
  return cancelled;
}

/** Work out the marketable sell price for the side we hold. */
async function sellPriceFor(ticker, side) {
  const resp = await api.getMarket(ticker);
  const m = (resp && resp.market) || resp || {};
  // To exit we SELL the side we hold, hitting that side's current bid.
  const bid = side === 'yes' ? m.yes_bid : m.no_bid;
  if (typeof bid === 'number' && bid > 0) {
    // Price a few cents inside the bid (EDGE) to make the fill more certain.
    return clampPrice(bid - EDGE);
  }
  // No visible bid — sell cheap so the order is marketable if any liquidity shows.
  return 1;
}

/** Step 2 — sell out of every open position. */
async function closePositions() {
  const positions = unwrap(await api.getPositions(), 'market_positions')
    .filter((p) => (p.position || 0) !== 0)
    .filter((p) => !ONLY_TICKER || p.ticker === ONLY_TICKER);

  if (positions.length === 0) {
    log('No open positions to close.');
    return 0;
  }

  log(`Found ${positions.length} open position(s) to close:`);
  let closed = 0;
  for (const p of positions) {
    const ticker = p.ticker;
    const contracts = Math.abs(p.position);
    const side = p.position > 0 ? 'yes' : 'no'; // positive = long yes, negative = long no
    let price;
    try {
      price = await sellPriceFor(ticker, side);
    } catch (e) {
      log(`  ✗ ${ticker}: could not read market price — ${e.message}`);
      continue;
    }

    const order = {
      ticker,
      client_order_id: crypto.randomUUID(),
      action: 'sell',
      side,
      count: contracts,
      type: 'limit',
      [side === 'yes' ? 'yes_price' : 'no_price']: price,
    };
    const desc = `${ticker}: SELL ${contracts} ${side.toUpperCase()} @ ${price}¢`;

    if (!LIVE) {
      log(`  would place: ${desc}`);
      continue;
    }
    try {
      const res = await api.createOrder(order);
      const oid = (res && res.order && res.order.order_id) || '';
      log(`  ✓ placed: ${desc} ${oid ? '(' + oid + ')' : ''}`);
      closed++;
    } catch (e) {
      log(`  ✗ order failed: ${desc} — ${e.message}`);
    }
    await sleep(300);
  }
  return closed;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  log(LIVE ? '=== LIVE MODE — this will cancel orders and sell positions ===' : '=== DRY RUN (no orders sent). Add --live to execute. ===');
  if (ONLY_TICKER) log(`Restricted to ticker: ${ONLY_TICKER}`);

  const bal = await api.getBalance().catch(() => null);
  if (bal && typeof bal.balance === 'number') {
    log(`Cash balance: $${(bal.balance / 100).toFixed(2)}`);
  }

  const cancelled = await cancelRestingOrders();
  const closed = await closePositions();

  log('─────────────────────────────');
  if (LIVE) {
    log(`Done. Cancelled ${cancelled} order(s), submitted ${closed} closing sell(s).`);
    log('Re-run to confirm everything is flat; sells fill against the current bid.');
  } else {
    log('Dry run complete. Re-run with --live to actually flatten:');
    log('  node close-positions.js --live');
  }
}

main().catch((e) => {
  console.error(`[flatten] FATAL: ${e.message}`);
  process.exit(1);
});
