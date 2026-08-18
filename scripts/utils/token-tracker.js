#!/usr/bin/env node
/**
 * token-tracker.js — Parse and track token usage from agent CLI logs
 *
 * Supports multiple runtime CLI formats:
 *   - Codex:        "tokens used\n<number>"
 *   - Claude Code:  JSON with "usage" object (input_tokens + output_tokens)
 *   - Kiro:         "Token usage: <number>"
 *   - Generic:      "Total tokens: <number>" or "Tokens: <number>"
 *
 * A single log file may contain multiple token entries (retries, resumes).
 * This module extracts all entries and computes totals per step and per flow.
 *
 * Token number formats observed:
 *   - 250,964  (comma-separated thousands)
 *   - 139.109  (dot-separated thousands — locale variant)
 *   - 0        (zero tokens — empty run)
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'team.json'), 'utf8'));
const { loadWorkflow, getSteps, listFlowIds, resolveWorkDir } = require('./flow-state');

function stripAnsi(str) {
  return String(str || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Parse a token number string that may use comma or dot as thousands separator.
 * Returns an integer.
 *
 * Examples:
 *   "250,964"  → 250964
 *   "139.109"  → 139109
 *   "0"        → 0
 *   "1,234,567" → 1234567
 */
function parseTokenNumber(str) {
  const trimmed = stripAnsi(str).trim();
  if (!trimmed || trimmed === '0') return 0;

  // Detect format:
  // If contains both comma and dot → ambiguous, but unlikely in this context
  // If contains only commas → comma = thousands separator
  // If contains only dots → could be thousands separator OR decimal
  //   Heuristic: if pattern is \d{1,3}\.\d{3} → thousands separator (e.g. 139.109)
  //              if pattern is \d+\.\d{1,2} → decimal (unlikely for token counts)

  // Remove all separators and parse as integer
  // Both "250,964" and "139.109" should become integers
  const commaCount = (trimmed.match(/,/g) || []).length;
  const dotCount = (trimmed.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount === 0) {
    // Pure comma format: 250,964 → 250964
    return parseInt(trimmed.replace(/,/g, ''), 10) || 0;
  }

  if (dotCount > 0 && commaCount === 0) {
    // Check if dot is thousands separator (e.g., 139.109 → 3 digits after dot)
    // or decimal (e.g., 3.14 → unlikely for tokens but handle)
    if (/^\d{1,3}(\.\d{3})+$/.test(trimmed)) {
      // Thousands separator pattern
      return parseInt(trimmed.replace(/\./g, ''), 10) || 0;
    }
    // Fallback: treat as decimal, take integer part
    return parseInt(trimmed, 10) || 0;
  }

  // Mixed or no separators
  return parseInt(trimmed.replace(/[,.\s]/g, ''), 10) || 0;
}

/**
 * Extract all token usage values from a log file content.
 * Supports multiple CLI output formats:
 *
 * 1. Codex: "tokens used\n<number>"
 * 2. Claude Code JSON: {"usage":{"input_tokens":N,"output_tokens":N},"total_cost_usd":N}
 * 3. Claude Code stream-json: lines with {"type":"result",...,"usage":{...}}
 * 4. Generic: "Total tokens: <number>" or "Tokens: <number>"
 *
 * Returns array of integers (each detected token entry = input + output combined).
 */
function extractTokensFromLog(content) {
  const tokens = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = stripAnsi(lines[i]).trim();

    // --- Format 1: Codex CLI ---
    // "tokens used"
    // "<number>"
    if (line === 'tokens used' && i + 1 < lines.length) {
      const value = parseTokenNumber(lines[i + 1]);
      if (value > 0) {
        tokens.push(value);
      }
      continue;
    }

    // --- Format 2: Claude Code JSON output (full response) ---
    // Look for JSON lines containing usage data
    if (line.startsWith('{') && line.includes('"usage"')) {
      try {
        const parsed = JSON.parse(line);
        // Claude Code result format: { "type": "result", "usage": { "input_tokens": N, "output_tokens": N }, "total_cost_usd": N }
        if (parsed.usage && (parsed.usage.input_tokens !== undefined || parsed.usage.output_tokens !== undefined)) {
          const inputTokens = parsed.usage.input_tokens || 0;
          const outputTokens = parsed.usage.output_tokens || 0;
          const cacheRead = parsed.usage.cache_read_input_tokens || 0;
          const cacheCreate = parsed.usage.cache_creation_input_tokens || 0;
          tokens.push(inputTokens + outputTokens + cacheRead + cacheCreate);
          continue;
        }
        // Nested format: { "result": "...", "usage": {...} }
        if (parsed.type === 'result' && parsed.usage) {
          const inputTokens = parsed.usage.input_tokens || 0;
          const outputTokens = parsed.usage.output_tokens || 0;
          tokens.push(inputTokens + outputTokens);
          continue;
        }
      } catch (e) {
        // Not valid JSON, continue
      }
    }

    // --- Format 3: Generic "Total tokens: N" or "Tokens: N" ---
    const genericMatch = line.match(/^(?:total\s+)?tokens?\s*[:=]\s*([\d,.\s]+)/i);
    if (genericMatch && !line.includes('used')) {
      // Avoid double-matching "tokens used" (handled above)
      const value = parseTokenNumber(genericMatch[1]);
      if (value > 0) {
        tokens.push(value);
        continue;
      }
    }

    // --- Format 4: Kiro CLI "▸ Credits: <number> • Time: <duration>" ---
    const kiroCreditsMatch = line.match(/[▸►]\s*Credits:\s*([\d.,]+)/);
    if (kiroCreditsMatch) {
      // Kiro reports credits, not raw tokens.
      // Store as negative value flag won't work — instead store as-is.
      // We convert credits to approximate tokens: 1 credit ≈ 10,000 tokens (rough estimate)
      // This is a heuristic; actual ratio depends on model and caching.
      const credits = parseFloat(kiroCreditsMatch[1].replace(',', '.'));
      if (credits > 0) {
        const approxTokens = Math.round(credits * 10000);
        tokens.push(approxTokens);
        continue;
      }
    }

    // --- Format 5: Generic "Token usage: N" ---
    const kiroMatch = line.match(/token\s+usage\s*[:=]\s*([\d,.\s]+)/i);
    if (kiroMatch) {
      const value = parseTokenNumber(kiroMatch[1]);
      if (value > 0) {
        tokens.push(value);
        continue;
      }
    }
  }

  return tokens;
}

/**
 * Parse token usage from a step's log file.
 * Returns { entries: number[], total: number, lastEntry: number }
 */
function parseStepTokens(flowId, step) {
  let flowDirectory;
  try {
    flowDirectory = resolveWorkDir(flowId);
  } catch {
    return { entries: [], total: 0, lastEntry: 0 };
  }
  const logFile = path.join(flowDirectory, 'logs', `${step}.log`);

  if (!fs.existsSync(logFile)) {
    return { entries: [], total: 0, lastEntry: 0 };
  }

  const content = fs.readFileSync(logFile, 'utf8');
  const entries = extractTokensFromLog(content);
  const total = entries.reduce((sum, v) => sum + v, 0);
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : 0;

  return { entries, total, lastEntry };
}

/**
 * Get token usage for all steps in a flow.
 * Returns { steps: { [step]: { entries, total, lastEntry } }, flowTotal: number }
 */
function getFlowTokens(flowId) {
  const steps = {};
  let flowTotal = 0;

  let stepsToUse = ['clarifier', 'architect', 'planner', 'implementer', 'verifier'];
  try {
    const workflow = loadWorkflow(flowId);
    stepsToUse = getSteps(workflow);
  } catch (e) {}

  for (const step of stepsToUse) {
    const result = parseStepTokens(flowId, step);
    steps[step] = result;
    flowTotal += result.total;
  }

  return { steps, flowTotal, stepsToUse };
}

/**
 * Format token number with comma separator for display.
 */
function formatTokens(num) {
  return num.toLocaleString('en-US');
}

/**
 * Generate a summary string for a flow's token usage.
 */
function formatFlowSummary(flowId) {
  const { steps, flowTotal, stepsToUse } = getFlowTokens(flowId);
  const lines = [];

  lines.push(`📊 Token Usage: ${flowId}`);
  lines.push(`${'─'.repeat(50)}`);

  for (const step of stepsToUse) {
    const data = steps[step];
    if (data.total > 0) {
      const retries = data.entries.length > 1 ? ` (${data.entries.length} sessions)` : '';
      lines.push(`  ${step.padEnd(14)} ${formatTokens(data.total).padStart(12)}${retries}`);
    } else {
      lines.push(`  ${step.padEnd(14)} ${'—'.padStart(12)}`);
    }
  }

  lines.push(`${'─'.repeat(50)}`);
  lines.push(`  ${'TOTAL'.padEnd(14)} ${formatTokens(flowTotal).padStart(12)}`);
  lines.push('');

  return lines.join('\n');
}

// --- CLI ---
if (require.main === module) {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'flow': {
      const flowId = args[0];
      if (!flowId) {
        console.error('Usage: token-tracker.js flow <flow-id>');
        process.exit(1);
      }
      console.log(formatFlowSummary(flowId));
      break;
    }

    case 'step': {
      const [flowId, step] = args;
      if (!flowId || !step) {
        console.error('Usage: token-tracker.js step <flow-id> <step>');
        process.exit(1);
      }
      const result = parseStepTokens(flowId, step);
      console.log(`📊 ${step} tokens: ${formatTokens(result.total)}`);
      if (result.entries.length > 1) {
        result.entries.forEach((v, i) => {
          console.log(`   Session ${i + 1}: ${formatTokens(v)}`);
        });
      }
      break;
    }

    case 'all': {
      // SQLite is authoritative; artifact directories are never discovered.
      const flows = listFlowIds();

      if (flows.length === 0) {
        console.log('No flows found.');
        break;
      }

      console.log(`📊 Token Usage Summary (all flows)`);
      console.log(`${'─'.repeat(60)}`);

      let grandTotal = 0;
      for (const flowId of flows.sort()) {
        const { flowTotal } = getFlowTokens(flowId);
        grandTotal += flowTotal;
        console.log(`  ${flowId.padEnd(40)} ${formatTokens(flowTotal).padStart(12)}`);
      }

      console.log(`${'─'.repeat(60)}`);
      console.log(`  ${'GRAND TOTAL'.padEnd(40)} ${formatTokens(grandTotal).padStart(12)}`);
      console.log('');
      break;
    }

    default:
      console.error('Usage: token-tracker.js <flow|step|all> [args]');
      console.error('');
      console.error('Commands:');
      console.error('  flow <flow-id>         Show token usage per step for a flow');
      console.error('  step <flow-id> <step>  Show token usage for a specific step');
      console.error('  all                    Show totals for all flows');
      process.exit(1);
  }
}

module.exports = {
  stripAnsi,
  parseTokenNumber,
  extractTokensFromLog,
  parseStepTokens,
  getFlowTokens,
  formatTokens,
  formatFlowSummary
};
