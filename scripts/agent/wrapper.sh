#!/usr/bin/env bash
# agent-wrapper.sh — Universal agent wrapper (dispatches to runtime-specific scripts)
#
# Replaces codex-agent-wrapper.sh with a pluggable runtime system.
# Backward-compatible: defaults to "codex" runtime if not specified.
#
# Usage: agent-wrapper.sh <flow-id> <step> <work-dir> <prompt-file> [worktree-path]
#
# Env vars (set by spawn-via-gateway.js):
#   AGENT_RUNTIME      - runtime name: codex|claude|kiro|opencode|generic (default: codex)
#   AGENT_MODEL        - model to use
#   AGENT_REASONING    - reasoning effort
#   AGENT_COMMAND      - custom command (generic runtime only)
set -euo pipefail

if [ $# -lt 4 ]; then
  echo "Usage: $0 <flow-id> <step> <work-dir> <prompt-file> [worktree-path]"
  exit 1
fi

FLOW_ID="$1"
STEP="$2"
WORK_DIR="$3"
PROMPT_FILE="$4"
WORKTREE_PATH="${5:-}"

# Derive paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REAL_REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME="${AGENT_RUNTIME:-codex}"
RUNTIME_SCRIPT="$SCRIPT_DIR/../runtimes/${RUNTIME}.sh"

# Validate worktree path if provided
if [ -n "$WORKTREE_PATH" ]; then
  if [ ! -d "$WORKTREE_PATH" ]; then
    echo "⚠️ Worktree path does not exist yet: $WORKTREE_PATH" | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || true
    echo "   Falling back to main repo. Worktree should be created by orchestrator." | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || true
    WORKTREE_PATH=""
  elif ! git -C "$WORKTREE_PATH" rev-parse --git-dir > /dev/null 2>&1; then
    echo "⚠️ Not a valid git worktree: $WORKTREE_PATH" | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || true
    echo "   Falling back to main repo." | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || true
    WORKTREE_PATH=""
  fi
fi

# Validate runtime script exists
if [ ! -f "$RUNTIME_SCRIPT" ]; then
  echo "❌ Unknown runtime: $RUNTIME (no script at $RUNTIME_SCRIPT)" >&2
  echo "   Available runtimes: $(ls "$SCRIPT_DIR/../runtimes/" | sed 's/\.sh$//' | tr '\n' ' ')" >&2
  exit 1
fi

# Setup directories and log
LOG_DIR="$WORK_DIR/logs"
mkdir -p "$LOG_DIR" "$WORK_DIR/output" "$WORK_DIR/prompts" "$WORK_DIR/scripts"
LOG_FILE="$LOG_DIR/${STEP}.log"
CURRENT_LINK="$LOG_DIR/current.log"
ln -sfn "${STEP}.log" "$CURRENT_LINK"

# Resolve output file path from team.json
SKILL_DIR="$REPO_ROOT"
OUTPUT_FILE="$WORK_DIR/$(node -e "
  const t = require('$SKILL_DIR/team.json');
  process.stdout.write(t.members['$STEP'].outputs[0]);
")"

# Working directory for the agent
CWD="${WORKTREE_PATH:-$REAL_REPO_ROOT}"

# Write log header
{
  echo "=== Dev Team Agent Stream ==="
  echo "Flow: $FLOW_ID"
  echo "Agent: $STEP"
  echo "Started: $(date)"
  echo "Work dir: $REAL_REPO_ROOT"
  echo "Prompt: $PROMPT_FILE"
  echo "Repo: $REAL_REPO_ROOT"
  echo "Worktree: ${WORKTREE_PATH:-none}"
  echo "Runtime: $RUNTIME"
  echo "Model: ${AGENT_MODEL:-default}"
  echo "Reasoning: ${AGENT_REASONING:-default}"
  echo "================================"
  echo ""
} | tee -a "$LOG_FILE"

# Crash sentinel: write ## Status FAILED if runtime exits non-zero and no output
write_crash_sentinel() {
  local code="$1"
  if [ "$code" -ne 0 ] && [ "$code" -ne 130 ] && [ "$code" -ne 143 ] && [ ! -s "$OUTPUT_FILE" ]; then
    cat > "$OUTPUT_FILE" <<SENTINEL
## Status FAILED

Exit code: $code
Runtime: $RUNTIME

Wrapper detected agent CLI exit with non-zero code and no output file.
This is an automated crash sentinel. See logs/$STEP.log for details.

_Written by agent-wrapper.sh trap_
SENTINEL
    echo "💀 Crash sentinel written: $OUTPUT_FILE" | tee -a "$LOG_FILE"
  fi
}

CLEANING_UP=0

# Propagate signals to entire process group so child CLI (kiro-cli, codex, etc.) gets killed
cleanup() {
  local sig="$1"
  if [ "$CLEANING_UP" -eq 1 ]; then
    exit 143
  fi
  CLEANING_UP=1
  trap '' TERM INT
  echo "" | tee -a "$LOG_FILE"
  echo "🛑 Received SIG${sig}, terminating child processes..." | tee -a "$LOG_FILE"
  # Kill all processes in our process group
  kill -"$sig" 0 2>/dev/null || true
  exit 143
}

trap 'cleanup TERM' TERM
trap 'cleanup INT' INT
trap 'write_crash_sentinel $?' EXIT

# Dispatch to runtime-specific script
set +e
bash "$RUNTIME_SCRIPT" "$PROMPT_FILE" "$LOG_FILE" "$WORK_DIR" "$CWD"
EXIT_CODE=$?
set -e

# Write log footer
{
  echo ""
  echo "================================"
  echo "Finished: $(date)"
  echo "Exit code: $EXIT_CODE"
  echo "Runtime: $RUNTIME"
} | tee -a "$LOG_FILE"

# Cleanup PID file
PID_FILE="$WORK_DIR/.pid.${STEP}"
rm -f "$PID_FILE"

# Auto-update workflow.json based on exit code and output status
WORKFLOW_FILE="$WORK_DIR/workflow.json"
if [ -f "$WORKFLOW_FILE" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    const exitCode = $EXIT_CODE;
    const step = '$STEP';
    const outputFile = '$OUTPUT_FILE';
    const wf = JSON.parse(fs.readFileSync('$WORKFLOW_FILE', 'utf8'));
    const team = JSON.parse(fs.readFileSync(path.join('$REPO_ROOT', 'team.json'), 'utf8'));

    function getSteps(workflow) {
      return workflow.stepOrder || Object.keys(workflow.steps || {});
    }

    function getFixTargetStep(workflow) {
      const steps = getSteps(workflow);
      if (steps.includes('developer')) return 'developer';
      if (steps.includes('implementer')) return 'implementer';
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (/(developer|implementer|frontend|backend|dev)/i.test(s)) return s;
      }
      return steps[0] || null;
    }

    function isReviewLikeOutput(filePath) {
      const lower = String(filePath || '').toLowerCase();
      return lower.endsWith('/output/review.md') || lower.endsWith('/output/qa.md') || lower.endsWith('/output/verification.md');
    }

    function contentImpliesNeedsFix(content) {
      const text = String(content || '');
      const negationRe = /\b(?:no|not|without|zero|none|n\/a|any)\b/i;
      const keywordPatterns = [
        /\bneeds?_fix\b/i,
        /\bneed\s+fix(?:es)?\b/i,
        /\bmust\s+fix\b/i,
        /\brequires?\s+fix(?:es)?\b/i,
        /\bfix\s+required\b/i,
        /\bfix\s+before\b/i,
        /\bnot\s+ready\b/i,
        /\bqa\s*[:\-]?\s*failed\b/i,
        /\breview\s*[:\-]?\s*failed\b/i,
        /\bfailed\b(?!\s*:\s*0)/i,
        /\bblocker(s)?\b/i,
        /\bcritical\s+bug(s)?\b/i,
        /\bmajor\s+bug(s)?\b/i,
        /\bphải\s+sửa\b/i,
        /\bcần\s+sửa\b/i,
        /\bkhông\s+đạt\b/i
      ];
      const sentences = text.split(/[.\n]+/);
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;
        for (const re of keywordPatterns) {
          if (re.test(trimmed)) {
            if (negationRe.test(trimmed)) continue;
            return true;
          }
        }
      }
      return false;
    }

    function parseStepStatus(stepName) {
      const member = team.members[stepName];
      if (!member || !member.outputs || !member.outputs[0]) return null;
      const file = path.join('$WORK_DIR', member.outputs[0]);
      if (!fs.existsSync(file)) return null;
      const content = fs.readFileSync(file, 'utf8');
      const match = content.match(/##\s*Status\s*[:\n]\s*(DONE|NEEDS_FIX|FAILED|BLOCKED|IN[ _]PROGRESS|NOT[ _]STARTED)/i);
      if (match) {
        const parsed = match[1].toUpperCase().replace(/ /g, '_');
        if (parsed === 'DONE' && isReviewLikeOutput(file) && contentImpliesNeedsFix(content)) return 'NEEDS_FIX';
        return parsed;
      }
      if (isReviewLikeOutput(file) && contentImpliesNeedsFix(content)) return 'NEEDS_FIX';
      return 'UNKNOWN';
    }

    function hasOutput(stepName) {
      const member = team.members[stepName];
      if (!member || !member.outputs || !member.outputs[0]) return false;
      return fs.existsSync(path.join('$WORK_DIR', member.outputs[0]));
    }

    function allStepsValidDone(workflow) {
      const steps = getSteps(workflow);
      return steps.every((s) => hasOutput(s) && parseStepStatus(s) === 'DONE');
    }

    // Parse status from output file (## Status DONE|FAILED|BLOCKED)
    let outputStatus = null;
    if (fs.existsSync(outputFile)) {
      const content = fs.readFileSync(outputFile, 'utf8');
      const match = content.match(/##\\s*Status\\s*[:\\n]\\s*(DONE|NEEDS_FIX|FAILED|BLOCKED)/i);
      if (match) outputStatus = match[1].toUpperCase().replace(/ /g, '_');
      if (outputStatus === 'DONE' && isReviewLikeOutput(outputFile) && contentImpliesNeedsFix(content)) {
        outputStatus = 'NEEDS_FIX';
      }
      if (!outputStatus && isReviewLikeOutput(outputFile) && contentImpliesNeedsFix(content)) {
        outputStatus = 'NEEDS_FIX';
      }
    }

    // Determine step status
    let stepStatus;
    const outputExists = fs.existsSync(outputFile);
    if (exitCode === 0 && outputStatus === 'DONE') {
      stepStatus = 'done';
    } else if (exitCode === 0 && !outputExists) {
      // Agent exited 0 but produced no output file — treat as failed for retry
      stepStatus = 'failed';
      wf.status = 'failed';
      console.log('⚠️  ' + step + ' exited 0 but no output file found: ' + outputFile + ' → retry');
      // Extract retry context from log for next attempt
      try {
        const logFile = path.join('$WORK_DIR', 'logs', step + '.log');
        if (fs.existsSync(logFile)) {
          const logContent = fs.readFileSync(logFile, 'utf8');
          const logLines = logContent.split('\n');
          const tail50 = logLines.slice(-50).join('\n');
          const errorLines = logLines.filter(l => /error|Error|failed|exception|Exception|panic|FATAL/i.test(l)).slice(-20).join('\n');
          let retryCtx = '# Retry Context — ' + step + '\n\n';
          retryCtx += 'Previous run exited with code 0 but produced no output.\n';
          retryCtx += 'Below are the last 50 lines of the log and any error lines found.\n\n';
          retryCtx += '## Last 50 Log Lines\n\n```\n' + tail50 + '\n```\n';
          if (errorLines.trim()) {
            retryCtx += '\n## Error Lines\n\n```\n' + errorLines + '\n```\n';
          }
          const retryCtxFile = path.join('$WORK_DIR', 'output', step + '-retry-context.md');
          fs.writeFileSync(retryCtxFile, retryCtx);
          console.log('📝 Retry context saved: output/' + step + '-retry-context.md');
        }
      } catch (e) {
        console.log('⚠️  Could not extract retry context: ' + e.message);
      }
    } else if (exitCode === 0 && outputExists && !outputStatus) {
      // Output exists but has no parseable status — treat as failed for retry
      stepStatus = 'failed';
      wf.status = 'failed';
      console.log('⚠️  ' + step + ' exited 0 but output has no ## Status marker → retry');
    } else if (outputStatus === 'BLOCKED') {
      stepStatus = 'blocked';
      wf.blockedStep = step;
      wf.blockedReason = 'Agent reported BLOCKED status';
      wf.status = 'blocked';
    } else if (outputStatus === 'NEEDS_FIX') {
      stepStatus = 'failed';
      wf.needsFixCount = wf.needsFixCount || {};
      wf.needsFixCount[step] = (wf.needsFixCount[step] || 0) + 1;
      wf.status = 'failed';
    } else {
      // exitCode != 0 or outputStatus === 'FAILED'
      stepStatus = 'failed';
      wf.status = 'failed';
    }

    wf.steps[step] = stepStatus;
    wf.currentStep = step;

    // Determine next step and auto-spawn if done
    let nextStep = null;
    if (stepStatus === 'done') {
      const allSteps = wf.stepOrder || Object.keys(wf.steps);
      const currentIdx = allSteps.indexOf(step);

      // Check all done → complete flow
      const allDone = allSteps.every(s => s === step || wf.steps[s] === 'done');
      if (allDone && allStepsValidDone(wf)) {
        wf.status = 'completed';
        wf.stoppedAt = new Date().toISOString();
      } else if (allDone) {
        const fixTarget = getFixTargetStep(wf);
        if (fixTarget) {
          wf.status = 'running';
          wf.currentStep = fixTarget;
          allSteps.forEach((s) => {
            if (s === fixTarget) wf.steps[s] = 'waiting';
            else if (allSteps.indexOf(s) > allSteps.indexOf(fixTarget)) wf.steps[s] = 'waiting';
          });
        }
      } else if (currentIdx >= 0 && currentIdx < allSteps.length - 1) {
        // More steps remain → set next as running
        nextStep = allSteps[currentIdx + 1];
        wf.currentStep = nextStep;
        wf.steps[nextStep] = 'running';
      }
    }

    // Write updated workflow once
    fs.writeFileSync('$WORKFLOW_FILE', JSON.stringify(wf, null, 2));
    console.log('✅ Workflow auto-updated: ' + step + ' = ' + stepStatus);

    // Auto-spawn next step as detached child process
    if (nextStep) {
      const repoRoot = '$REPO_ROOT';
      const scriptDir = path.join(repoRoot, 'scripts', 'api');
      const spawnScript = path.join(scriptDir, 'spawn.js');
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [spawnScript, '$FLOW_ID', nextStep], {
        cwd: repoRoot,
        stdio: 'ignore',
        detached: true,
        env: Object.assign({}, process.env)
      });
      child.unref();
      console.log('▶️  Auto-spawned next step: ' + nextStep + ' (PID ' + (child.pid || 'N/A') + ')');
    }

    console.log('✅ Workflow auto-updated: ' + step + ' = ' + stepStatus);
  " 2>&1 | tee -a "$LOG_FILE"
fi

exit $EXIT_CODE
