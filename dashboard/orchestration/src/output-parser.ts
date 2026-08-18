export type ParsedOutputStatus = 'DONE' | 'NEEDS_FIX' | 'BLOCKED' | 'FAILED' | 'UNKNOWN';

const STATUS_MARKER = /##\s*Status\s*(?::|\n)\s*(DONE|NEEDS[ _]FIX|FAILED|BLOCKED)\b/i;

function isReviewOutput(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  return normalized.endsWith('/review.md')
    || normalized.endsWith('/qa.md')
    || normalized.endsWith('/verification.md');
}

function reviewNeedsFix(content: string): boolean {
  const negative = /\b(?:no|not|without|zero|none|n\/a)\b/i;
  const signals = [
    /\bneeds?[ _]fix\b/i,
    /\bmust\s+fix\b/i,
    /\brequires?\s+fix(?:es)?\b/i,
    /\bfix\s+required\b/i,
    /\bnot\s+ready\b/i,
    /\b(?:qa|review)\s*[:\-]?\s*failed\b/i,
    /\bblockers?\b/i,
    /\b(?:critical|major)\s+bugs?\b/i,
    /\b(?:phải|cần)\s+sửa\b/i,
    /\bkhông\s+đạt\b/i,
  ];
  for (const rawLine of content.split(/[.\n]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:[-*]\s*)?(?:passed|failed|warnings?|total|tests?|errors?|skipped)\s*[:\-]\s*\d+/i.test(line)) continue;
    if (/^(?:[-*]\s*)?(?:overall|\*\*actual\*\*)\s*[:\-]/i.test(line)) continue;
    if (negative.test(line)) continue;
    if (signals.some((signal) => signal.test(line))) return true;
  }
  return false;
}

export function parseOutputStatus(content: string, filePath: string): ParsedOutputStatus {
  const explicit = STATUS_MARKER.exec(content);
  if (explicit) return explicit[1].toUpperCase().replace(' ', '_') as ParsedOutputStatus;
  if (isReviewOutput(filePath) && reviewNeedsFix(content)) return 'NEEDS_FIX';
  return 'UNKNOWN';
}
