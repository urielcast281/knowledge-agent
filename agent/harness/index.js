/**
 * Agent harness — public surface + CLI.
 *
 * Library usage:
 *   const { createAgent } = require('./harness');
 *   const agent = createAgent({ system: 'You are helpful.', workspace: __dirname });
 *   const { text } = await agent.run('List the files here and summarize them.');
 *
 * CLI usage:
 *   ANTHROPIC_API_KEY=sk-... node harness <goal...>
 *   ANTHROPIC_API_KEY=sk-... node harness            # interactive REPL
 */

const path = require('path');
const { Agent } = require('./agent');
const { ToolRegistry, builtins } = require('./tools');
const { Memory, memoryTools } = require('./memory');
const { createMessage, DEFAULT_MODEL } = require('./claude');
const { every } = require('./scheduler');

/**
 * Build a ready-to-run agent with file/shell/memory tools.
 *
 * @param {object} [opts]
 * @param {string} [opts.system]            - system prompt
 * @param {string} [opts.workspace]         - root for file/shell tools (default cwd)
 * @param {string} [opts.memoryFile]        - path for persistent memory
 * @param {string[]} [opts.allowedShell]    - shell allowlist
 * @param {function} [opts.approve]         - approval gate for side-effects
 * @param {boolean} [opts.stream]           - live stream to stdout (default true)
 * @param {Array}  [opts.extraTools]        - additional tool definitions
 * @returns {Agent}
 */
function createAgent(opts = {}) {
  const workspace = path.resolve(opts.workspace || process.cwd());
  const registry = new ToolRegistry();

  for (const t of builtins({ root: workspace, allowedShell: opts.allowedShell })) {
    registry.register(t);
  }

  const memory = new Memory(opts.memoryFile || path.join(workspace, 'agent-memory.json'));
  for (const t of memoryTools(memory)) registry.register(t);

  if (opts.extraTools) for (const t of opts.extraTools) registry.register(t);

  const agent = new Agent({
    registry,
    system: opts.system,
    model: opts.model,
    maxTokens: opts.maxTokens,
    maxIterations: opts.maxIterations,
    approve: opts.approve,
    stream: opts.stream,
    log: opts.log,
  });

  agent.registry = registry;
  agent.memory = memory;
  return agent;
}

module.exports = {
  createAgent,
  Agent,
  ToolRegistry,
  builtins,
  Memory,
  memoryTools,
  createMessage,
  every,
  DEFAULT_MODEL,
};

// --- CLI -------------------------------------------------------------------
if (require.main === module) {
  const SYSTEM =
    'You are a capable autonomous agent running in a terminal harness. ' +
    'You have file, shell, and memory tools scoped to the current workspace. ' +
    'Work toward the goal directly; use tools when they help; when done, give a ' +
    'short plain-language summary of what you did.';

  const agent = createAgent({ system: SYSTEM, workspace: process.cwd() });
  const goal = process.argv.slice(2).join(' ').trim();

  const banner = () =>
    console.error(`\n\x1b[1m[harness]\x1b[0m ${DEFAULT_MODEL} | workspace: ${process.cwd()}\n`);

  if (goal) {
    banner();
    agent
      .run(goal)
      .then((r) => {
        console.error(`\n\n\x1b[2m[done] ${r.iterations} turns, ` +
          `${r.usage.input_tokens}+${r.usage.output_tokens} tokens\x1b[0m`);
        process.exit(0);
      })
      .catch((e) => {
        console.error('\n[error]', e.message);
        process.exit(1);
      });
  } else {
    // Interactive REPL — keeps one conversation across turns.
    banner();
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let messages = [];

    const prompt = () => rl.question('\x1b[1myou ›\x1b[0m ', async (line) => {
      const input = line.trim();
      if (!input) return prompt();
      if (input === '/exit' || input === '/quit') return rl.close();
      messages.push({ role: 'user', content: input });
      process.stdout.write('\x1b[1magent ›\x1b[0m ');
      try {
        const r = await agent.run(messages);
        messages = r.messages; // carry full history (incl. tool calls) forward
      } catch (e) {
        console.error('\n[error]', e.message);
      }
      console.log('\n');
      prompt();
    });

    prompt();
  }
}
