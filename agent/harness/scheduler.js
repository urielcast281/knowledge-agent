/**
 * Scheduler — run an agent on a recurring interval (the OpenClaw "wake up on a
 * schedule" pattern, kept dependency-free). For real cron, wrap runOnce() in a
 * system crontab entry instead; this is for long-lived processes.
 */

/**
 * Run `task` immediately, then every `intervalMs`. Returns a stop() function.
 * Overlapping runs are skipped (a slow run won't stack up).
 *
 * @param {function} task        - async () => any
 * @param {number}   intervalMs  - delay between runs
 * @param {object}   [opts]
 * @param {boolean}  [opts.runAtStart=true]
 * @param {function} [opts.onError] - (err) => void
 */
function every(task, intervalMs, opts = {}) {
  const onError = opts.onError || ((e) => console.error('[scheduler]', e.message));
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await task();
    } catch (e) {
      onError(e);
    } finally {
      running = false;
    }
  };

  if (opts.runAtStart !== false) tick();
  const handle = setInterval(tick, intervalMs);

  return function stop() {
    stopped = true;
    clearInterval(handle);
  };
}

module.exports = { every };
