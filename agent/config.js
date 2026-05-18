/**
 * Kalshi Trader Agent — Configuration
 */

const path = require('path');

module.exports = {
  // API credentials
  apiKey: '639bc4cb-f8b0-475e-89a2-0972b6d4a88e',
  privateKeyPath: path.join(__dirname, '..', '..', '.kalshi_private.pem'),
  host: 'api.elections.kalshi.com',

  // Risk management
  maxTradeSize: 5,          // max $5 per trade
  maxOpenPositions: 8,      // max concurrent positions
  minBalance: 0.50,         // stop trading below $0.50
  maxDailyLoss: 3.00,       // stop after $3 loss in a day

  // Weather strategy thresholds
  weather: {
    minBuffer: 3,           // minimum degrees between forecast and strike
    minConfidence: 'high',  // minimum forecast confidence
    maxSpread: 4,           // max spread between forecast sources
    minEdge: 15,            // minimum edge in cents (e.g., buy at 75¢ when true prob is 90%)
  },

  // Series tickers for weather markets
  weatherSeries: [
    'KXHIGHNY', 'KXHIGHCHI', 'KXHIGHMIA', 'KXHIGHDEN',
    'KXHIGHPHX', 'KXHIGHLV', 'KXHIGHSEA', 'KXHIGHSFO',
    'KXHIGHLAX', 'KXHIGHAUS', 'KXHIGHSAT', 'KXHIGHTHOU',
    'KXHIGHTDC', 'KXHIGHTDAL', 'KXHIGHTBOS', 'KXHIGHTATL',
    'KXHIGHTNOLA', 'KXHIGHTMIN', 'KXHIGHTOKC',
    'KXLOWTNY', 'KXLOWTCHI', 'KXLOWTMIA', 'KXLOWTDEN',
    'KXLOWTPHX', 'KXLOWTLV', 'KXLOWTSEA', 'KXLOWTSFO',
    'KXLOWTLAX', 'KXLOWTAUS', 'KXLOWTSAT',
  ],

  // Logging
  logDir: path.join(__dirname, 'logs'),
  tradeLog: path.join(__dirname, 'logs', 'trades.json'),
  dailyLog: path.join(__dirname, 'logs', 'daily.json'),
  scanLog: path.join(__dirname, 'logs', 'scans.json'),
};
