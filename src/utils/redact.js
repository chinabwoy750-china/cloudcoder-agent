const PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  /AIza[A-Za-z0-9\-_]{30,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,            // Telegram bot token
  /(Bearer\s+)[A-Za-z0-9\-_.~+/]+=*/gi,
  /(api[_-]?key|token|secret|password|authorization)["']?\s*[=:]\s*["']?([^\s"',}]{8,})["']?/gi,
  /\/\/[^:@/\s]+:[^@/\s]+@/g,                     // credentials in URLs
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p, (m, prefix) => {
      if (m.startsWith('//')) return '//[REDACTED]@';
      return prefix && m.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return out;
}
