# Agent Harness

A small, dependency-free agent harness — the OpenClaw-style runtime layer that
drives Claude in a loop with tool use, persistent memory, and scheduling. Pure
Node.js (CommonJS), talks to the Anthropic Messages API over raw `https`, no
`npm install`.

It's a **general-purpose** harness: point it at a goal, give it tools, and it
runs the model → executes tools → feeds results back → repeats until done.

## What's here

| File | Role |
|------|------|
| `claude.js` | Anthropic Messages API client over raw HTTPS. Streams SSE, assembles the final message, adaptive thinking, retries with backoff. |
| `tools.js` | `ToolRegistry` + safe built-in tools (`read_file`, `write_file`, `list_files`, `run_shell`). File ops are confined to a workspace root; the shell tool runs an **allowlist** of executables, not an open shell. |
| `memory.js` | `Memory` — a JSON key/value store that persists across runs, plus `remember`/`recall` tools. |
| `agent.js` | `Agent` — the core loop. Manual agentic loop with an optional human-approval gate for side-effecting tools and an observability `log` hook. |
| `scheduler.js` | `every(task, intervalMs)` — run an agent on a cadence (skips overlapping runs). |
| `index.js` | Public exports + a CLI (one-shot and interactive REPL). |

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

That's it — no install step.

## CLI

```bash
# one-shot
node agent/harness "List the files here and summarize what this project does."

# interactive REPL (keeps one conversation; /exit to quit)
node agent/harness
```

The CLI scopes file/shell tools to the current working directory and streams the
model's reasoning (dim) and answer live.

## Library

```js
const { createAgent } = require('./agent/harness');

const agent = createAgent({
  system: 'You are a careful coding assistant.',
  workspace: __dirname,                 // file/shell tools confined here
  memoryFile: './agent-memory.json',
  allowedShell: ['ls', 'cat', 'node'],  // shell allowlist
  approve: async (name, input) => {     // optional: gate side-effects
    return name !== 'run_shell';        // e.g. auto-deny shell, allow the rest
  },
});

const { text, iterations, usage } = await agent.run('Refactor utils.js and run the tests.');
console.log(text);
```

### Add your own tools

A tool is `{ name, description, input_schema, run(input, ctx) }`:

```js
const agent = createAgent({
  extraTools: [{
    name: 'get_price',
    description: 'Get the current price for a Kalshi ticker.',
    input_schema: {
      type: 'object',
      properties: { ticker: { type: 'string' } },
      required: ['ticker'],
    },
    run: async ({ ticker }) => {
      const kalshi = require('../kalshi-api');
      const m = await kalshi.request('GET', `/markets/${ticker}`);
      return JSON.stringify(m.market);
    },
  }],
});
```

This is how you'd wire the harness into the existing Kalshi tooling in this repo:
expose `kalshi-api.js` calls as tools and let the agent reason over live market data.

### Schedule it

```js
const { createAgent, every } = require('./agent/harness');
const agent = createAgent({ system: '...' });

const stop = every(() => agent.run('Run the periodic scan and report.'), 30 * 60 * 1000);
// later: stop();
```

## Design notes

- **Model:** `claude-opus-4-8` with adaptive thinking (the model decides how much
  to think). Thinking blocks are replayed verbatim across turns, as the API requires.
- **Streaming:** every request streams, so large outputs never hit a request
  timeout. The SSE events are assembled back into a normal message object.
- **Safety:** file tools can't escape the workspace root (`..`/absolute paths are
  rejected); `run_shell` is an allowlist, not a shell — no pipes, redirects, or
  operators. Use the `approve` hook for human-in-the-loop on anything destructive.
- **Zero dependencies:** matches the rest of this repo — only Node built-ins.

## Boundary

This harness will run whatever tools you give it. It is **not** built to defeat
another site's anti-bot, queue, or CAPTCHA protections — don't wire tools whose
purpose is circumventing a third party's access controls.
