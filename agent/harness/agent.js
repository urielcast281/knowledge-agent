/**
 * Agent — the core loop that drives Claude with tool use until it's done.
 *
 * This is the "harness": it owns the conversation, runs the model, executes
 * the tools the model asks for (through your ToolRegistry), feeds results back,
 * and repeats until the model stops calling tools. Optional approval gate lets
 * you require human confirmation before side-effecting tools run.
 */

const { createMessage } = require('./claude');

class Agent {
  /**
   * @param {object} opts
   * @param {ToolRegistry} opts.registry   - tools the agent may call
   * @param {string} [opts.system]         - system prompt / persona
   * @param {string} [opts.model]          - model id
   * @param {number} [opts.maxTokens]      - max output tokens per turn
   * @param {number} [opts.maxIterations]  - hard cap on tool-loop turns (default 25)
   * @param {function} [opts.approve]      - async (name, input) => bool, gate side-effects
   * @param {function} [opts.log]          - (event, data) => void, observability hook
   * @param {boolean} [opts.stream]        - print text/thinking live to stdout (default true)
   */
  constructor(opts = {}) {
    if (!opts.registry) throw new Error('Agent requires a tool registry');
    this.registry = opts.registry;
    this.system = opts.system;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
    this.maxIterations = opts.maxIterations || 25;
    this.approve = opts.approve;
    this.log = opts.log || (() => {});
    this.stream = opts.stream !== false;
  }

  /**
   * Run the agent toward a goal. Returns { text, messages, iterations, usage }.
   * @param {string|Array} goal - a user message string, or a full messages array
   */
  async run(goal) {
    const messages = Array.isArray(goal) ? goal.slice() : [{ role: 'user', content: goal }];
    const tools = this.registry.definitions();
    const totalUsage = { input_tokens: 0, output_tokens: 0 };
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;
      this.log('turn:start', { iteration: iterations });

      const resp = await createMessage({
        messages,
        system: this.system,
        tools,
        model: this.model,
        maxTokens: this.maxTokens,
        onText: this.stream ? (t) => process.stdout.write(t) : undefined,
        onThinking: this.stream ? (t) => process.stdout.write(dim(t)) : undefined,
      });

      accumulate(totalUsage, resp.usage);
      messages.push({ role: 'assistant', content: resp.content });

      if (resp.stop_reason === 'refusal') {
        this.log('refusal', resp.stop_details || {});
        return { text: '[refused]', messages, iterations, usage: totalUsage, refused: true };
      }

      // Server-side tool loop hit its limit — resend to resume.
      if (resp.stop_reason === 'pause_turn') {
        this.log('pause_turn', {});
        continue;
      }

      if (resp.stop_reason !== 'tool_use') {
        // end_turn / stop_sequence / max_tokens — we're done.
        const text = textOf(resp.content);
        this.log('turn:done', { stop_reason: resp.stop_reason });
        return { text, messages, iterations, usage: totalUsage, stop_reason: resp.stop_reason };
      }

      // Execute every tool_use block, collect a tool_result for each.
      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      const results = [];
      for (const call of toolUses) {
        results.push(await this._execute(call));
      }
      messages.push({ role: 'user', content: results });
    }

    this.log('max_iterations', { maxIterations: this.maxIterations });
    return {
      text: '[stopped: hit max iterations]',
      messages,
      iterations,
      usage: totalUsage,
      stopped: true,
    };
  }

  async _execute(call) {
    this.log('tool:call', { name: call.name, input: call.input });

    // Approval gate for side-effecting tools.
    if (this.approve) {
      let ok;
      try {
        ok = await this.approve(call.name, call.input);
      } catch {
        ok = false;
      }
      if (!ok) {
        this.log('tool:denied', { name: call.name });
        return toolResult(call.id, `denied by approval policy`, true);
      }
    }

    try {
      const out = await this.registry.run(call.name, call.input, { agent: this });
      this.log('tool:result', { name: call.name, ok: true });
      return toolResult(call.id, out, false);
    } catch (err) {
      this.log('tool:result', { name: call.name, ok: false, error: err.message });
      return toolResult(call.id, `error: ${err.message}`, true);
    }
  }
}

function toolResult(id, content, isError) {
  return { type: 'tool_result', tool_use_id: id, content: String(content), is_error: !!isError };
}

function textOf(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function accumulate(total, usage) {
  if (!usage) return;
  total.input_tokens += usage.input_tokens || 0;
  total.output_tokens += usage.output_tokens || 0;
}

function dim(s) {
  return `\x1b[2m${s}\x1b[0m`;
}

module.exports = { Agent };
