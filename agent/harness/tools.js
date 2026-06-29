/**
 * Tool registry + safe built-in tools for the agent harness.
 *
 * A tool is: { name, description, input_schema, run(input, ctx) -> string }.
 * Register your own with registry.register({...}). The built-ins below are
 * scoped to a workspace root and refuse to escape it; the shell tool runs
 * against an allowlist of executables rather than an open shell.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.run !== 'function') {
      throw new Error('register() requires { name, run, ... }');
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name) {
    return this.tools.has(name);
  }

  /** Definitions in the shape the Messages API expects. */
  definitions() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.input_schema || { type: 'object', properties: {} },
    }));
  }

  /** Execute a tool by name. Returns a string (or stringifies the result). */
  async run(name, input, ctx) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    const out = await tool.run(input || {}, ctx || {});
    return typeof out === 'string' ? out : JSON.stringify(out);
  }
}

/** Resolve a model-supplied path and confine it to `root`. Throws on escape. */
function safeResolve(root, p) {
  const resolved = path.resolve(root, p || '.');
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${p}`);
  }
  return resolved;
}

/**
 * Built-in tools scoped to `root` (default: process.cwd()).
 *
 * @param {object} [opts]
 * @param {string} [opts.root]        - workspace root for file ops
 * @param {string[]} [opts.allowedShell] - executable allowlist for run_shell
 */
function builtins(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const allowedShell = opts.allowedShell || ['ls', 'cat', 'node', 'grep', 'wc', 'head', 'tail'];

  return [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file within the workspace.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace root' } },
        required: ['path'],
      },
      run: (input) => {
        const file = safeResolve(root, input.path);
        return fs.readFileSync(file, 'utf8');
      },
    },

    {
      name: 'write_file',
      description: 'Write (overwrite) a UTF-8 text file within the workspace. Creates parent dirs.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
      run: (input) => {
        const file = safeResolve(root, input.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, input.content, 'utf8');
        return `wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`;
      },
    },

    {
      name: 'list_files',
      description: 'List entries in a directory within the workspace.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to root (default ".")' } },
      },
      run: (input) => {
        const dir = safeResolve(root, input.path || '.');
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join('\n');
      },
    },

    {
      name: 'run_shell',
      description:
        'Run an allowlisted command with arguments. Not a shell — no pipes, ' +
        'redirects, or operators. Only these executables are permitted: ' +
        allowedShell.join(', ') + '.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Executable name (must be allowlisted)' },
          args: { type: 'array', items: { type: 'string' }, description: 'Argument list' },
        },
        required: ['command'],
      },
      run: (input) =>
        new Promise((resolve) => {
          if (!allowedShell.includes(input.command)) {
            return resolve(`refused: "${input.command}" is not in the allowlist`);
          }
          execFile(
            input.command,
            input.args || [],
            { cwd: root, timeout: 30000, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err && err.killed) return resolve('error: command timed out');
              const out = (stdout || '') + (stderr || '');
              resolve(out.slice(0, 20000) || (err ? `error: ${err.message}` : '(no output)'));
            },
          );
        }),
    },
  ];
}

module.exports = { ToolRegistry, builtins, safeResolve };
