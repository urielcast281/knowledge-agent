/**
 * Minimal Telegram Bot API client — just enough to post a message to a channel.
 * Uses Node's built-in fetch (Node 18+); no extra dependency.
 */

const config = require('../config');

async function sendMessage(text, opts = {}) {
  const { botToken, chatId } = config.telegram;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set.');

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parseMode || 'HTML',
    disable_web_page_preview: true,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `Telegram sendMessage failed (HTTP ${res.status}): ${data.description || JSON.stringify(data)}`
    );
  }
  return data.result;
}

module.exports = { sendMessage };
