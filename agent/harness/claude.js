/**
 * Claude client — Anthropic Messages API over raw HTTPS (zero dependencies).
 *
 * Mirrors the style of kalshi-api.js: built-in `https`, retry with backoff,
 * no SDK. Streams the response (SSE) and assembles the final message so large
 * outputs never hit a request timeout.
 *
 * Auth: reads ANTHROPIC_API_KEY from the environment.
 * Default model: claude-opus-4-8 with adaptive thinking.
 */

const https = require('https');

const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * Call the Messages API with streaming and return the assembled message:
 *   { content: [...blocks], stop_reason, stop_details, usage, model }
 *
 * @param {object} opts
 * @param {Array}  opts.messages        - conversation history (required)
 * @param {string} [opts.system]        - system prompt
 * @param {Array}  [opts.tools]         - tool definitions
 * @param {object} [opts.tool_choice]   - tool_choice override
 * @param {string} [opts.model]         - model id (default claude-opus-4-8)
 * @param {number} [opts.maxTokens]     - max output tokens (default 16000)
 * @param {string} [opts.thinkingDisplay] - "summarized" | "omitted" (default summarized)
 * @param {function} [opts.onText]      - callback(textDelta) for live streaming
 * @param {function} [opts.onThinking]  - callback(thinkingDelta) for live reasoning
 * @param {number} [opts.retries]       - network retries (default 3)
 */
function createMessage(opts) {
  const {
    messages,
    system,
    tools,
    tool_choice,
    model = DEFAULT_MODEL,
    maxTokens = 16000,
    thinkingDisplay = 'summarized',
    onText,
    onThinking,
    retries = 3,
  } = opts;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Promise.reject(new Error('ANTHROPIC_API_KEY is not set in the environment'));
  }

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    // Adaptive thinking is the recommended mode on Opus 4.8 — Claude decides
    // when and how much to think. `display: summarized` surfaces a readable
    // reasoning summary for logging; thinking blocks are still replayed verbatim.
    thinking: { type: 'adaptive', display: thinkingDisplay },
    messages,
  };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;

  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const options = {
        hostname: API_HOST,
        path: API_PATH,
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          // Retryable: drain and back off.
          res.resume();
          if (n < retries) {
            const delay = Math.min(1000 * 2 ** n, 16000);
            return setTimeout(() => attempt(n + 1), delay);
          }
        }

        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => (errBody += c));
          res.on('end', () =>
            reject(new Error(`Anthropic API ${res.statusCode}: ${errBody.slice(0, 500)}`)),
          );
          return;
        }

        const assembler = new MessageAssembler({ onText, onThinking });
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          // SSE events are separated by a blank line.
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            assembler.feed(rawEvent);
          }
        });
        res.on('end', () => {
          try {
            resolve(assembler.finish());
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', (err) => {
        if (n < retries) {
          const delay = Math.min(1000 * 2 ** n, 16000);
          return setTimeout(() => attempt(n + 1), delay);
        }
        reject(err);
      });

      req.write(payload);
      req.end();
    };

    attempt(0);
  });
}

/**
 * Accumulates SSE events into a complete message with typed content blocks.
 */
class MessageAssembler {
  constructor({ onText, onThinking } = {}) {
    this.onText = onText;
    this.onThinking = onThinking;
    this.blocks = [];
    this.partialJson = {}; // index -> accumulated tool input json string
    this.stopReason = null;
    this.stopDetails = null;
    this.usage = {};
    this.model = null;
  }

  feed(rawEvent) {
    // Each event block has `event: <type>` and `data: <json>` lines.
    let dataLine = '';
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) dataLine += line.slice(5).trim();
    }
    if (!dataLine) return;

    let evt;
    try {
      evt = JSON.parse(dataLine);
    } catch {
      return; // ignore malformed/keepalive lines
    }

    switch (evt.type) {
      case 'message_start':
        this.model = evt.message && evt.message.model;
        if (evt.message && evt.message.usage) this.usage = evt.message.usage;
        break;

      case 'content_block_start': {
        const block = evt.content_block;
        this.blocks[evt.index] = block;
        if (block.type === 'tool_use') this.partialJson[evt.index] = '';
        break;
      }

      case 'content_block_delta': {
        const d = evt.delta;
        const block = this.blocks[evt.index];
        if (!block) break;
        if (d.type === 'text_delta') {
          block.text = (block.text || '') + d.text;
          if (this.onText) this.onText(d.text);
        } else if (d.type === 'thinking_delta') {
          block.thinking = (block.thinking || '') + d.thinking;
          if (this.onThinking) this.onThinking(d.thinking);
        } else if (d.type === 'signature_delta') {
          block.signature = (block.signature || '') + d.signature;
        } else if (d.type === 'input_json_delta') {
          this.partialJson[evt.index] += d.partial_json;
        }
        break;
      }

      case 'content_block_stop': {
        const block = this.blocks[evt.index];
        if (block && block.type === 'tool_use') {
          const raw = this.partialJson[evt.index];
          block.input = raw ? JSON.parse(raw) : {};
        }
        break;
      }

      case 'message_delta':
        if (evt.delta && evt.delta.stop_reason) this.stopReason = evt.delta.stop_reason;
        if (evt.delta && evt.delta.stop_details) this.stopDetails = evt.delta.stop_details;
        if (evt.usage) this.usage = Object.assign({}, this.usage, evt.usage);
        break;

      case 'error':
        throw new Error(`stream error: ${JSON.stringify(evt.error)}`);

      default:
        break;
    }
  }

  finish() {
    return {
      content: this.blocks.filter(Boolean),
      stop_reason: this.stopReason,
      stop_details: this.stopDetails,
      usage: this.usage,
      model: this.model,
    };
  }
}

module.exports = { createMessage, DEFAULT_MODEL };
