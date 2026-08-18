import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  parseTokensFromLog,
  parseTokenNumber,
  formatElapsedTime,
  calculateProgress,
  statusToIndicatorClass,
  calculateBackoff,
  trimLogBuffer,
} from './format';
import type { AgentStep, StepStatus } from '@devteam-dashboard/shared';

describe('formatTokens', () => {
  it('returns — for zero', () => {
    expect(formatTokens(0)).toBe('—');
  });

  it('formats millions', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(1_000_000)).toBe('1.0M');
  });

  it('formats thousands', () => {
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(1_000)).toBe('1.0K');
    expect(formatTokens(999_999)).toBe('1000.0K');
  });

  it('returns raw number for small values', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(1)).toBe('1');
  });
});

describe('parseTokenNumber', () => {
  it('parses plain numbers', () => {
    expect(parseTokenNumber('12345')).toBe(12345);
  });

  it('handles comma separator', () => {
    expect(parseTokenNumber('1,234,567')).toBe(1234567);
  });

  it('handles dot separator', () => {
    expect(parseTokenNumber('1.234.567')).toBe(1234567);
  });

  it('handles whitespace', () => {
    expect(parseTokenNumber('  1 234 567  ')).toBe(1234567);
  });

  it('returns 0 for invalid input', () => {
    expect(parseTokenNumber('abc')).toBe(0);
    expect(parseTokenNumber('')).toBe(0);
  });
});

describe('parseTokensFromLog', () => {
  it('extracts token entries from log content', () => {
    const content = `Starting step
tokens used
1500
Some other output
tokens used
3000
Done`;
    expect(parseTokensFromLog(content)).toEqual([1500, 3000]);
  });

  it('extracts ANSI-colored token entries', () => {
    const content = `\x1b[2mtokens used\x1b[0m
384,024
\x1b[2mtokens used\x1b[0m
174,597`;
    expect(parseTokensFromLog(content)).toEqual([384024, 174597]);
  });

  it('returns empty array when no tokens found', () => {
    expect(parseTokensFromLog('no tokens here')).toEqual([]);
  });

  it('skips zero/invalid token values', () => {
    const content = `tokens used
abc
tokens used
500`;
    expect(parseTokensFromLog(content)).toEqual([500]);
  });
});

describe('formatElapsedTime', () => {
  it('formats seconds only', () => {
    const start = '2024-01-01T00:00:00Z';
    const now = new Date('2024-01-01T00:00:45Z');
    expect(formatElapsedTime(start, now)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    const start = '2024-01-01T00:00:00Z';
    const now = new Date('2024-01-01T00:05:30Z');
    expect(formatElapsedTime(start, now)).toBe('5m 30s');
  });

  it('formats hours, minutes, and seconds', () => {
    const start = '2024-01-01T00:00:00Z';
    const now = new Date('2024-01-01T02:15:45Z');
    expect(formatElapsedTime(start, now)).toBe('2h 15m 45s');
  });

  it('returns 0s for negative diff', () => {
    const start = '2024-01-01T01:00:00Z';
    const now = new Date('2024-01-01T00:00:00Z');
    expect(formatElapsedTime(start, now)).toBe('0s');
  });

  it('returns 0s for zero diff', () => {
    const start = '2024-01-01T00:00:00Z';
    const now = new Date('2024-01-01T00:00:00Z');
    expect(formatElapsedTime(start, now)).toBe('0s');
  });
});

describe('calculateProgress', () => {
  it('returns 0% when no steps done', () => {
    const steps: Record<AgentStep, StepStatus> = {
      clarifier: 'waiting',
      architect: 'waiting',
      planner: 'waiting',
      implementer: 'waiting',
      verifier: 'waiting',
    };
    expect(calculateProgress(steps)).toEqual({ completed: 0, total: 5, percentage: 0 });
  });

  it('returns 100% when all steps done', () => {
    const steps: Record<AgentStep, StepStatus> = {
      clarifier: 'done',
      architect: 'done',
      planner: 'done',
      implementer: 'done',
      verifier: 'done',
    };
    expect(calculateProgress(steps)).toEqual({ completed: 5, total: 5, percentage: 100 });
  });

  it('calculates partial progress correctly', () => {
    const steps: Record<AgentStep, StepStatus> = {
      clarifier: 'done',
      architect: 'done',
      planner: 'running',
      implementer: 'waiting',
      verifier: 'waiting',
    };
    expect(calculateProgress(steps)).toEqual({ completed: 2, total: 5, percentage: 40 });
  });
});

describe('statusToIndicatorClass', () => {
  it('maps all known statuses to non-empty classes', () => {
    const statuses: StepStatus[] = [
      'waiting', 'queued', 'running', 'done', 'needs_fix', 'failed',
      'blocked', 'cancelled', 'retrying',
    ];
    for (const status of statuses) {
      const cls = statusToIndicatorClass(status);
      expect(cls).toBeTruthy();
      expect(cls.length).toBeGreaterThan(0);
    }
  });

  it('maps specific statuses to expected colors', () => {
    expect(statusToIndicatorClass('waiting')).toContain('gray');
    expect(statusToIndicatorClass('running')).toContain('blue');
    expect(statusToIndicatorClass('done')).toContain('green');
    expect(statusToIndicatorClass('failed')).toContain('red');
    expect(statusToIndicatorClass('blocked')).toContain('purple');
  });

  it('returns fallback for unknown status', () => {
    expect(statusToIndicatorClass('nonexistent' as StepStatus)).toBe('bg-gray-400');
  });
});

describe('calculateBackoff', () => {
  it('doubles delay each attempt', () => {
    expect(calculateBackoff(0)).toBe(1000);
    expect(calculateBackoff(1)).toBe(2000);
    expect(calculateBackoff(2)).toBe(4000);
    expect(calculateBackoff(3)).toBe(8000);
  });

  it('caps at maxDelay', () => {
    expect(calculateBackoff(10)).toBe(30000);
    expect(calculateBackoff(20)).toBe(30000);
  });

  it('respects custom baseDelay and maxDelay', () => {
    expect(calculateBackoff(0, 500, 10000)).toBe(500);
    expect(calculateBackoff(3, 500, 10000)).toBe(4000);
    expect(calculateBackoff(5, 500, 10000)).toBe(10000);
  });
});

describe('trimLogBuffer', () => {
  it('returns lines unchanged when under limit', () => {
    const lines = ['a', 'b', 'c'];
    expect(trimLogBuffer(lines, 10)).toBe(lines);
  });

  it('trims to most recent lines when over limit', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const result = trimLogBuffer(lines, 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe('line-15');
    expect(result[4]).toBe('line-19');
  });

  it('uses default max of 1000', () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `line-${i}`);
    const result = trimLogBuffer(lines);
    expect(result).toHaveLength(1000);
    expect(result[0]).toBe('line-500');
  });
});
