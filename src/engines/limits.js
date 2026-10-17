// Shared retry / rate-limit helpers.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Worth retrying (rate limit / transient network)? */
export function isTransient(message = "") {
  return /HTTP (408|409|425|429|500|502|503|504)|timeout|timed out|fetch failed|ECONNRESET|socket hang up|aborted|rate limit|quota|overloaded/i.test(message);
}

/** Model retired / not found — worth switching model, not retrying. */
export function isModelMissing(message = "") {
  return /HTTP (404|410)/.test(message) || /model[^.]{0,80}(not found|does not exist|gone|decommission|retire|s unavailable)/i.test(message);
}

/** Provider-requested wait, e.g. "retry-after=12" appended to the error message. */
export function retryAfterMs(message = "") {
  const m = String(message).match(/retry[- _]?after[=:\s]+(\d+(?:\.\d+)?)/i);
  return m ? Math.min(Number(m[1]) * 1000, 180000) : 0;
}
