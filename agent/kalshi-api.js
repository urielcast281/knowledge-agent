/**
 * Kalshi API Client — Shared module
 * RSA-PSS signing, retry logic, rate limit handling
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const config = require('./config');

const PRIVATE_KEY = fs.readFileSync(config.privateKeyPath, 'utf8');

function sign(timestamp, method, fullPath) {
  const message = timestamp + method.toUpperCase() + fullPath;
  return crypto.sign('sha256', Buffer.from(message), {
    key: PRIVATE_KEY,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}

function request(method, apiPath, body = null, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const fullPath = '/trade-api/v2' + apiPath;
      const pathOnly = fullPath.split('?')[0];
      const signature = sign(timestamp, method, pathOnly);

      const options = {
        hostname: config.host,
        path: fullPath,
        method: method.toUpperCase(),
        headers: {
          'KALSHI-ACCESS-KEY': config.apiKey,
          'KALSHI-ACCESS-SIGNATURE': signature,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data || '{}')); }
            catch { resolve(data); }
          } else if (res.statusCode === 429 && n > 0) {
            const wait = parseInt(res.headers['retry-after'] || '2') * 1000;
            setTimeout(() => attempt(n - 1), wait);
          } else if (res.statusCode >= 500 && n > 0) {
            setTimeout(() => attempt(n - 1), 2000);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', (err) => {
        if (n > 0) setTimeout(() => attempt(n - 1), 2000);
        else reject(err);
      });
      req.setTimeout(15000, () => {
        req.destroy();
        if (n > 0) setTimeout(() => attempt(n - 1), 2000);
        else reject(new Error('Timeout'));
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    };
    attempt(retries);
  });
}

function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

module.exports = {
  getBalance: () => request('GET', '/portfolio/balance'),

  getMarkets: (params = {}) => request('GET', '/markets' + qs(params)),
  getMarket: (ticker) => request('GET', `/markets/${ticker}`),
  getEvent: (eventTicker) => request('GET', `/events/${eventTicker}`),
  getEvents: (params = {}) => request('GET', '/events' + qs(params)),

  getOrderbook: (ticker, params = {}) => request('GET', `/orderbook/${ticker}` + qs(params)),

  getPositions: (params = {}) => request('GET', '/portfolio/positions' + qs(params)),
  getFills: (params = {}) => request('GET', '/portfolio/fills' + qs(params)),

  getOrders: (params = {}) => request('GET', '/portfolio/orders' + qs(params)),
  createOrder: (body) => request('POST', '/portfolio/orders', body),
  cancelOrder: (orderId) => request('DELETE', `/portfolio/orders/${orderId}`),

  getSeries: (seriesTicker) => request('GET', `/series/${seriesTicker}`),
  getTrades: (ticker, params = {}) => request('GET', `/markets/trades` + qs({ ticker, ...params })),
  getMarketHistory: (ticker, params = {}) => request('GET', `/markets/${ticker}/history` + qs(params)),
};
