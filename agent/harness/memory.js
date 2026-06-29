/**
 * Memory — a tiny JSON-file key/value store that persists across runs.
 *
 * Lets an agent jot down learnings in one session and recall them in the next.
 * Exposed to the model as two tools (remember / recall) via memoryTools().
 */

const fs = require('fs');
const path = require('path');

class Memory {
  constructor(file) {
    this.file = file || path.join(process.cwd(), 'agent-memory.json');
    this.data = {};
    this._load();
  }

  _load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
    return value;
  }

  delete(key) {
    delete this.data[key];
    this._save();
  }

  keys() {
    return Object.keys(this.data);
  }

  /** A compact snapshot suitable for injecting into a system prompt. */
  snapshot() {
    const keys = this.keys();
    if (!keys.length) return '(memory is empty)';
    return keys.map((k) => `- ${k}: ${JSON.stringify(this.data[k])}`).join('\n');
  }
}

/** Tool definitions backing a Memory instance. Register these on a ToolRegistry. */
function memoryTools(memory) {
  return [
    {
      name: 'remember',
      description: 'Persist a fact under a key so it survives across sessions.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short identifier for the fact' },
          value: { type: 'string', description: 'The fact to store' },
        },
        required: ['key', 'value'],
      },
      run: (input) => {
        memory.set(input.key, input.value);
        return `remembered "${input.key}"`;
      },
    },
    {
      name: 'recall',
      description: 'Read a stored fact by key, or list all keys if no key is given.',
      input_schema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key to read (optional)' } },
      },
      run: (input) => {
        if (!input.key) return memory.keys().join('\n') || '(empty)';
        const v = memory.get(input.key);
        return v === undefined ? `(no memory for "${input.key}")` : JSON.stringify(v);
      },
    },
  ];
}

module.exports = { Memory, memoryTools };
