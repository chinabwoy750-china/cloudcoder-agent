/**
 * Lightweight in-process metrics for observability (no external dependency).
 */
const startedAt = Date.now();
const counters = new Map();

export function incMetric(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}

export function getMetricsSnapshot() {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    pid: process.pid,
    node: process.version,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    counters: Object.fromEntries(counters.entries()),
  };
}
