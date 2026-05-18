# Knowledge — Kalshi Prediction Market Trading Agent

## Overview
Knowledge is an autonomous trading agent that operates on Kalshi prediction markets using the Kelly Criterion + Probability Arbitrage strategy.

## Strategy

### Core Process
1. **Estimate true probability (p)** using all available information
2. **Read market price** (crowd's implied probability)
3. **Compare**: If your p differs by ≥10% from market price, you have an edge
4. **Calculate bet size** using Half-Kelly: `f = ((p*b - q) / b) / 2`
5. **Bet f% of bankroll**, never more than 20% on a single bet

### Risk Management
- **Half-Kelly** position sizing (never full Kelly)
- **Max 20%** of bankroll on any single bet
- **Stop trading** below $5 bankroll
- **Daily loss limit**: 15% of bankroll
- **Max 10** concurrent open positions
- **Minimum edge**: 10% to take a position

### Edge Sources
- Weather model vs market mispricing
- Public bias on popular sports teams
- Incumbency base rates in politics
- Fed predictability premium
- Crypto optimism bias
- Late-converging contracts near resolution

## Files
- `knowledge-trader.js` — Main trading script (run standalone)
- `knowledge-state.json` — Persistent state (bankroll, positions, P&L)
- `knowledge-log.json` — Trade log (last 500 entries)

## Running
```bash
cd /mnt/c/Users/harim/.openclaw/workspace/kalshi/agent
node knowledge-trader.js
```

## Cron Schedule
Runs every 30 minutes autonomously. Reports results to Telegram.

## API Credentials
- API Key: Configured in script
- Private Key: `~/.openclaw/workspace/.kalshi_private.pem`
- Host: `api.elections.kalshi.com`
