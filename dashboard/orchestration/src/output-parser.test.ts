import { describe, expect, it } from 'vitest';
import { parseOutputStatus } from './output-parser.js';

describe('parseOutputStatus', () => {
  it('treats an explicit status as authoritative over metrics', () => {
    expect(parseOutputStatus('## Status\nDONE\n\nTests: 10 passed, 0 failed', '/tmp/review.md')).toBe('DONE');
  });

  it('only uses review heuristics when the marker is absent', () => {
    expect(parseOutputStatus('Review: must fix the authentication check', '/tmp/review.md')).toBe('NEEDS_FIX');
    expect(parseOutputStatus('Tests: 10 passed, 0 failed', '/tmp/review.md')).toBe('UNKNOWN');
    expect(parseOutputStatus('must fix this', '/tmp/implementation.md')).toBe('UNKNOWN');
  });

  it('parses all explicit domain statuses', () => {
    expect(parseOutputStatus('## Status: NEEDS FIX', '/tmp/x.md')).toBe('NEEDS_FIX');
    expect(parseOutputStatus('## Status\nBLOCKED', '/tmp/x.md')).toBe('BLOCKED');
    expect(parseOutputStatus('## Status: FAILED', '/tmp/x.md')).toBe('FAILED');
  });
});
