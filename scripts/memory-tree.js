#!/usr/bin/env node
/**
 * memory-tree.js — Hierarchical Task Memory Tree for dev-team pipeline
 *
 * Manages a tree structure where each node = 1 agent step,
 * storing compact state. Generates active-context.md for next agent.
 *
 * Structure (Option B - multi-flow per task):
 *   .tasks/<TASK_ID>/
 *     meta.json            ← list of flows, latest flow pointer
 *     flows/
 *       <flow_id>/
 *         tree.json        ← per-flow tree (nodes for each step)
 *         archive/         ← full parsed data per step
 *     active-context.md    ← generated from latest flow (or merged)
 *
 * Usage:
 *   node memory-tree.js init <flow-id>
 *   node memory-tree.js update <flow-id> <step>
 *   node memory-tree.js generate <flow-id> <step>
 *   node memory-tree.js status <flow-id>
 *   node memory-tree.js history <task-id>
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname);
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'team.json'), 'utf8'));
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || '.dev-team/task-flows');
const STEPS = ['clarifier', 'architect', 'planner', 'implementer', 'verifier'];
const { parseStepTokens, getFlowTokens, formatTokens, formatFlowSummary } = require('./lib/token-tracker');

// --- Core Functions ---

/**
 * Resolve task ID from flow. Uses jiraKey from workflow.json if available.
 */
function resolveTaskId(flowId) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  const workflowPath = path.join(workDir, 'workflow.json');
  if (!fs.existsSync(workflowPath)) return flowId;
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  return workflow.jiraKey || flowId;
}

/**
 * Get the .tasks/<TASK_ID> directory at repo root
 */
function getTaskDir(flowId) {
  const taskId = resolveTaskId(flowId);
  return path.join(REPO_ROOT, '.tasks', taskId);
}

/**
 * Get the flow-specific directory within task dir
 */
function getFlowDir(flowId) {
  const taskDir = getTaskDir(flowId);
  return path.join(taskDir, 'flows', flowId);
}

function getTreePath(flowId) {
  return path.join(getFlowDir(flowId), 'tree.json');
}

function getActiveContextPath(flowId) {
  return path.join(getTaskDir(flowId), 'active-context.md');
}

function getArchivePath(flowId, step) {
  return path.join(getFlowDir(flowId), 'archive', `${step}.json`);
}

function getMetaPath(flowId) {
  return path.join(getTaskDir(flowId), 'meta.json');
}

// --- Legacy path helpers (for migration) ---

function getLegacyTreePath(flowId) {
  return path.join(getTaskDir(flowId), 'tree.json');
}

function getLegacyArchiveDir(flowId) {
  return path.join(getTaskDir(flowId), 'archive');
}

/**
 * Migrate legacy flat structure to new multi-flow structure.
 * Moves .tasks/<TASK_ID>/tree.json → .tasks/<TASK_ID>/flows/<flow_id>/tree.json
 * Moves .tasks/<TASK_ID>/archive/* → .tasks/<TASK_ID>/flows/<flow_id>/archive/*
 *
 * Only runs if legacy tree.json exists and flows/ directory doesn't have the flow yet.
 */
function migrateLegacyIfNeeded(flowId) {
  const taskDir = getTaskDir(flowId);
  const legacyTreePath = path.join(taskDir, 'tree.json');
  const flowDir = getFlowDir(flowId);

  // If no legacy tree exists, nothing to migrate
  if (!fs.existsSync(legacyTreePath)) return;

  // If flow dir already exists with tree.json, already migrated
  if (fs.existsSync(path.join(flowDir, 'tree.json'))) return;

  console.log(`🔄 Migrating legacy memory tree to multi-flow structure...`);

  // Read legacy tree to get its flow_id
  let legacyTree;
  try {
    legacyTree = JSON.parse(fs.readFileSync(legacyTreePath, 'utf8'));
  } catch (e) {
    console.error(`⚠️  Cannot parse legacy tree.json: ${e.message}`);
    return;
  }

  const legacyFlowId = legacyTree.flow_id || flowId;
  const legacyFlowDir = path.join(taskDir, 'flows', legacyFlowId);

  // Create flow directory
  fs.mkdirSync(path.join(legacyFlowDir, 'archive'), { recursive: true });

  // Move tree.json
  fs.writeFileSync(path.join(legacyFlowDir, 'tree.json'), JSON.stringify(legacyTree, null, 2));
  fs.unlinkSync(legacyTreePath);

  // Move archive files
  const legacyArchiveDir = path.join(taskDir, 'archive');
  if (fs.existsSync(legacyArchiveDir)) {
    const archiveFiles = fs.readdirSync(legacyArchiveDir);
    for (const file of archiveFiles) {
      const src = path.join(legacyArchiveDir, file);
      const dst = path.join(legacyFlowDir, 'archive', file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
      }
    }
    // Remove legacy archive dir if empty
    try { fs.rmdirSync(legacyArchiveDir); } catch (e) { /* not empty or gone */ }
  }

  // Create/update meta.json
  const metaPath = path.join(taskDir, 'meta.json');
  const meta = loadOrCreateMeta(taskDir, legacyTree.task_id || resolveTaskId(flowId));
  if (!meta.flows.find(f => f.flow_id === legacyFlowId)) {
    meta.flows.push({
      flow_id: legacyFlowId,
      started_at: legacyTree.created_at || new Date().toISOString(),
      prompt_summary: '(migrated from legacy)',
      status: getFlowStatus(legacyTree)
    });
  }
  meta.latest_flow_id = legacyFlowId;
  meta.updated_at = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`✅ Migrated legacy tree for flow ${legacyFlowId}`);
}

/**
 * Load or create meta.json for a task
 */
function loadOrCreateMeta(taskDir, taskId) {
  const metaPath = path.join(taskDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  }
  return {
    task_id: taskId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    latest_flow_id: null,
    flows: []
  };
}

/**
 * Determine flow status from tree nodes
 */
function getFlowStatus(tree) {
  const nodes = tree.nodes || {};
  const statuses = Object.values(nodes).map(n => n.status);
  if (statuses.includes('FAILED')) return 'failed';
  if (statuses.includes('BLOCKED')) return 'blocked';
  // Check if all nodes are DONE (handles both old 7-step and new 5-step flows)
  if (statuses.length >= STEPS.length && statuses.every(s => s === 'DONE')) return 'completed';
  return 'in_progress';
}

/**
 * Initialize memory tree for a flow
 */
function initTree(flowId) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  if (!fs.existsSync(workDir)) {
    console.error(`❌ Flow not found: ${flowId}`);
    return null;
  }

  const taskDir = getTaskDir(flowId);
  const flowDir = getFlowDir(flowId);
  const archiveDir = path.join(flowDir, 'archive');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(flowDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  // Migrate legacy structure if present
  migrateLegacyIfNeeded(flowId);

  // Read workflow for metadata
  const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
  const taskId = workflow.jiraKey || flowId;

  const tree = {
    task_id: taskId,
    flow_id: flowId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    prompt_summary: (workflow.customPrompt || '').slice(0, 200),
    nodes: {}
  };

  const treePath = getTreePath(flowId);
  fs.writeFileSync(treePath, JSON.stringify(tree, null, 2));

  // Update meta.json
  const meta = loadOrCreateMeta(taskDir, taskId);
  // Remove existing entry for this flow if re-initializing
  meta.flows = meta.flows.filter(f => f.flow_id !== flowId);
  meta.flows.push({
    flow_id: flowId,
    started_at: tree.created_at,
    prompt_summary: tree.prompt_summary,
    status: 'in_progress'
  });
  meta.latest_flow_id = flowId;
  meta.updated_at = new Date().toISOString();
  const metaPath = getMetaPath(flowId);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`✅ Memory tree initialized: ${treePath}`);
  return tree;
}

/**
 * Parse an agent output file and extract key information
 */
function parseOutputFile(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf8');
  const result = {
    status: 'UNKNOWN',
    summary: '',
    key_facts: [],
    decisions: [],
    sections: {}
  };

  // Extract status
  const statusMatch = content.match(/##\s*Status\s*[:\n]\s*(DONE|NEEDS_FIX|FAILED|BLOCKED)/i);
  if (statusMatch) {
    result.status = statusMatch[1].toUpperCase();
  }

  // Extract sections
  const sectionRegex = /^##\s+(.+)$/gm;
  let match;
  const sectionPositions = [];

  while ((match = sectionRegex.exec(content)) !== null) {
    sectionPositions.push({ name: match[1].trim(), start: match.index + match[0].length });
  }

  for (let i = 0; i < sectionPositions.length; i++) {
    const end = i + 1 < sectionPositions.length ? sectionPositions[i + 1].start - sectionPositions[i + 1].name.length - 4 : content.length;
    const sectionContent = content.slice(sectionPositions[i].start, end).trim();
    result.sections[sectionPositions[i].name] = sectionContent;
  }

  // Extract summary from first meaningful paragraph or Summary section
  if (result.sections['Summary'] || result.sections['Ticket Summary'] || result.sections['Problem Restatement']) {
    result.summary = (result.sections['Summary'] || result.sections['Ticket Summary'] || result.sections['Problem Restatement']).slice(0, 300);
  } else {
    // Take first non-empty, non-header line
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('## Status'));
    result.summary = (lines[0] || '').slice(0, 300);
  }

  // Extract key facts from bullet lists in important sections
  const factSections = ['Core Requirements', 'Impacted Repos/Modules', 'Implementation Approach',
    'Design Decisions', 'Changed Files', 'Critical Issues', 'Test Cases'];

  for (const sectionName of factSections) {
    if (result.sections[sectionName]) {
      const bullets = result.sections[sectionName]
        .split('\n')
        .filter(l => l.match(/^[-*]\s+/))
        .map(l => l.replace(/^[-*]\s+/, '').trim())
        .slice(0, 5); // Max 5 facts per section
      result.key_facts.push(...bullets);
    }
  }

  // Keep key_facts concise
  result.key_facts = result.key_facts.slice(0, 10);

  // Extract decisions
  if (result.sections['Design Decisions']) {
    const decisionLines = result.sections['Design Decisions']
      .split('\n')
      .filter(l => l.match(/^\d+\.\s+/))
      .map(l => l.replace(/^\d+\.\s+/, '').trim())
      .slice(0, 5);
    result.decisions = decisionLines.map(d => ({ what: d }));
  }

  return result;
}

/**
 * Update tree with completed step output
 */
function updateTree(flowId, step) {
  const treePath = getTreePath(flowId);
  if (!fs.existsSync(treePath)) {
    console.log(`⚠️  Tree not found, initializing...`);
    initTree(flowId);
  }

  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
  const workDir = path.join(OUTPUT_ROOT, flowId);
  const member = TEAM_CONFIG.members[step];

  if (!member) {
    console.error(`❌ Unknown step: ${step}`);
    return null;
  }

  // Parse the output file
  const outputFile = path.join(workDir, member.outputs[0]);
  const parsed = parseOutputFile(outputFile);

  if (!parsed) {
    console.error(`⚠️  No output file found for ${step}`);
    return tree;
  }

  // Parse token usage from log
  const tokenData = parseStepTokens(flowId, step);

  // Create/update node for this step within this flow's tree
  tree.nodes[step] = {
    step,
    role: member.role,
    status: parsed.status,
    summary: parsed.summary,
    key_facts: parsed.key_facts,
    decisions: parsed.decisions,
    tokens_used: tokenData.total,
    token_sessions: tokenData.entries,
    completed_at: new Date().toISOString()
  };

  tree.updated_at = new Date().toISOString();

  // Recalculate flow total tokens
  tree.tokens_total = Object.values(tree.nodes)
    .reduce((sum, node) => sum + (node.tokens_used || 0), 0);

  fs.writeFileSync(treePath, JSON.stringify(tree, null, 2));

  // Save full parsed data to archive (per-flow, so no cross-flow overwrite)
  const archivePath = getArchivePath(flowId, step);
  fs.writeFileSync(archivePath, JSON.stringify({
    step,
    parsed_at: new Date().toISOString(),
    ...parsed
  }, null, 2));

  // Update meta.json with latest flow status
  const taskDir = getTaskDir(flowId);
  const metaPath = getMetaPath(flowId);
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const flowEntry = meta.flows.find(f => f.flow_id === flowId);
    if (flowEntry) {
      flowEntry.status = getFlowStatus(tree);
      flowEntry.last_step = step;
      flowEntry.last_updated = new Date().toISOString();
    }
    meta.latest_flow_id = flowId;
    meta.updated_at = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  console.log(`✅ Tree updated: ${step} → ${parsed.status} [flow: ${flowId}]`);
  return tree;
}

/**
 * Generate active-context.md for the next agent to consume.
 * Includes context from the current flow AND relevant prior flows for the same task.
 */
function generateActiveContext(flowId, targetStep) {
  const treePath = getTreePath(flowId);
  if (!fs.existsSync(treePath)) {
    console.log(`⚠️  No memory tree found for ${flowId}, skipping context generation`);
    return null;
  }

  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
  const stepIndex = STEPS.indexOf(targetStep);

  if (stepIndex < 0) {
    console.error(`❌ Unknown step: ${targetStep}`);
    return null;
  }

  // Build context from all prior completed nodes in THIS flow
  let md = `# Task Context: ${tree.task_id} (auto-generated)\n\n`;
  md += `> This file is auto-generated from memory tree. Read this first for quick context.\n`;
  md += `> For full details, read the original output files listed below.\n`;
  md += `> Flow: ${flowId}\n\n`;

  // Include prior flows context if available
  const taskDir = getTaskDir(flowId);
  const metaPath = getMetaPath(flowId);
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const priorFlows = meta.flows.filter(f => f.flow_id !== flowId && f.status === 'completed');

    if (priorFlows.length > 0) {
      md += `## Prior Flows (same task)\n\n`;
      md += `This task has been worked on before. Key context from prior flows:\n\n`;

      for (const priorFlow of priorFlows.slice(-3)) { // Last 3 completed flows
        const priorTreePath = path.join(taskDir, 'flows', priorFlow.flow_id, 'tree.json');
        if (fs.existsSync(priorTreePath)) {
          const priorTree = JSON.parse(fs.readFileSync(priorTreePath, 'utf8'));
          md += `### Flow: ${priorFlow.flow_id}\n`;
          md += `- Started: ${priorFlow.started_at}\n`;
          md += `- Prompt: ${priorFlow.prompt_summary || '(none)'}\n`;

          // Include key decisions and facts from prior flow
          const priorDecisions = [];
          const priorFacts = [];
          for (const node of Object.values(priorTree.nodes)) {
            if (node.decisions && node.decisions.length > 0) {
              priorDecisions.push(...node.decisions.map(d => d.what));
            }
            if (node.key_facts && node.key_facts.length > 0) {
              priorFacts.push(...node.key_facts.slice(0, 3));
            }
          }

          if (priorDecisions.length > 0) {
            md += `- Decisions: ${priorDecisions.slice(0, 5).join('; ')}\n`;
          }
          if (priorFacts.length > 0) {
            md += `- Key facts: ${priorFacts.slice(0, 5).join('; ')}\n`;
          }
          md += `\n`;
        }
      }
    }
  }

  // Collect prior steps info from CURRENT flow
  const priorNodes = [];
  for (let i = 0; i < stepIndex; i++) {
    const s = STEPS[i];
    if (tree.nodes[s] && tree.nodes[s].status === 'DONE') {
      priorNodes.push(tree.nodes[s]);
    }
  }

  if (priorNodes.length === 0) {
    md += `## Prior Context\n\nNo prior steps completed yet in this flow. This is the first step.\n`;
  } else {
    // Problem/Requirements (from clarifier)
    if (tree.nodes.clarifier) {
      md += `## Problem\n\n${tree.nodes.clarifier.summary}\n\n`;
      if (tree.nodes.clarifier.key_facts.length > 0) {
        md += `**Requirements:**\n`;
        tree.nodes.clarifier.key_facts.forEach(f => { md += `- ${f}\n`; });
        md += `\n`;
      }
    }

    // Architecture (from architect)
    if (tree.nodes.architect) {
      md += `## Architecture\n\n${tree.nodes.architect.summary}\n\n`;
      if (tree.nodes.architect.decisions.length > 0) {
        md += `**Decisions:**\n`;
        tree.nodes.architect.decisions.forEach(d => { md += `- ${d.what}\n`; });
        md += `\n`;
      }
      if (tree.nodes.architect.key_facts.length > 0) {
        md += `**Impacted:**\n`;
        tree.nodes.architect.key_facts.forEach(f => { md += `- ${f}\n`; });
        md += `\n`;
      }
    }

    // Task breakdown & Plan (from planner)
    if (tree.nodes.planner) {
      md += `## Plan\n\n${tree.nodes.planner.summary}\n\n`;
      if (tree.nodes.planner.key_facts.length > 0) {
        tree.nodes.planner.key_facts.forEach(f => { md += `- ${f}\n`; });
        md += `\n`;
      }
    }

    // Implementation (from implementer)
    if (tree.nodes.implementer) {
      md += `## Implementation\n\n${tree.nodes.implementer.summary}\n\n`;
      if (tree.nodes.implementer.key_facts.length > 0) {
        md += `**Changes:**\n`;
        tree.nodes.implementer.key_facts.forEach(f => { md += `- ${f}\n`; });
        md += `\n`;
      }
    }

    // Verification (from verifier)
    if (tree.nodes.verifier) {
      md += `## Verification\n\n${tree.nodes.verifier.summary}\n\n`;
      if (tree.nodes.verifier.key_facts.length > 0) {
        tree.nodes.verifier.key_facts.forEach(f => { md += `- ${f}\n`; });
        md += `\n`;
      }
    }
  }

  // Current step info
  md += `## Current Step: ${targetStep}\n\n`;
  md += `You are the **${TEAM_CONFIG.members[targetStep].role}**.\n`;
  md += `Objective: ${TEAM_CONFIG.members[targetStep].objective}\n\n`;

  // Pipeline progress
  md += `## Pipeline Progress\n\n`;
  STEPS.forEach((s, i) => {
    const node = tree.nodes[s];
    if (i < stepIndex) {
      const status = node ? (node.status === 'DONE' ? '✓' : '✗') : '—';
      const tokenInfo = node && node.tokens_used ? ` (${formatTokens(node.tokens_used)} tokens)` : '';
      md += `${status} ${s}${tokenInfo}\n`;
    } else if (i === stepIndex) {
      md += `→ ${s} ← current\n`;
    } else {
      md += `○ ${s}\n`;
    }
  });

  // Token usage summary
  if (tree.tokens_total) {
    md += `\n## Token Usage So Far\n\n`;
    md += `Total tokens consumed by prior steps: **${formatTokens(tree.tokens_total)}**\n`;
  }

  // Write
  const contextPath = getActiveContextPath(flowId);
  fs.writeFileSync(contextPath, md);
  console.log(`✅ Active context generated: ${contextPath}`);
  return contextPath;
}

/**
 * Show tree status for a specific flow
 */
function showStatus(flowId) {
  const treePath = getTreePath(flowId);
  if (!fs.existsSync(treePath)) {
    console.log(`❌ No memory tree for ${flowId}`);
    return;
  }

  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
  console.log(`📊 Memory Tree: ${tree.task_id} (${tree.flow_id})`);
  console.log(`   Updated: ${tree.updated_at}`);
  if (tree.tokens_total) {
    console.log(`   💰 Total tokens: ${formatTokens(tree.tokens_total)}`);
  }
  console.log('');

  STEPS.forEach(s => {
    const node = tree.nodes[s];
    if (node) {
      const icon = node.status === 'DONE' ? '✅' : node.status === 'FAILED' ? '❌' : '⚠️';
      const tokenInfo = node.tokens_used ? ` [${formatTokens(node.tokens_used)} tokens]` : '';
      console.log(`  ${icon} ${s}: ${node.status}${tokenInfo}`);
      console.log(`     ${node.summary.slice(0, 80)}...`);
    } else {
      console.log(`  ○ ${s}: (not started)`);
    }
  });
}

/**
 * Show history of all flows for a task
 */
function showHistory(taskIdOrFlowId) {
  // Try to find the task directory
  let taskDir;

  // First check if it's a direct task ID
  const directPath = path.join(REPO_ROOT, '.tasks', taskIdOrFlowId);
  if (fs.existsSync(directPath)) {
    taskDir = directPath;
  } else {
    // Try to resolve from flow ID
    taskDir = getTaskDir(taskIdOrFlowId);
  }

  const metaPath = path.join(taskDir, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    console.log(`❌ No meta.json found for: ${taskIdOrFlowId}`);
    return;
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  console.log(`📜 Flow History: ${meta.task_id}`);
  console.log(`   Total flows: ${meta.flows.length}`);
  console.log(`   Latest: ${meta.latest_flow_id}`);
  console.log('');

  meta.flows.forEach((flow, i) => {
    const isLatest = flow.flow_id === meta.latest_flow_id;
    const icon = flow.status === 'completed' ? '✅' :
                 flow.status === 'failed' ? '❌' :
                 flow.status === 'blocked' ? '🚫' : '⏳';
    const marker = isLatest ? ' ← latest' : '';
    console.log(`  ${i + 1}. ${icon} ${flow.flow_id}${marker}`);
    console.log(`     Started: ${flow.started_at}`);
    console.log(`     Status: ${flow.status}`);
    if (flow.prompt_summary) {
      console.log(`     Prompt: ${flow.prompt_summary.slice(0, 100)}...`);
    }
    if (flow.last_step) {
      console.log(`     Last step: ${flow.last_step}`);
    }
    console.log('');
  });
}

/**
 * Show token usage summary for a flow (from logs, not cached tree data)
 */
function showTokens(flowId) {
  console.log(formatFlowSummary(flowId));
}

// --- CLI ---

if (require.main === module) {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'init':
      if (!args[0]) { console.error('Usage: memory-tree.js init <flow-id>'); process.exit(1); }
      initTree(args[0]);
      break;

    case 'update':
      if (args.length < 2) { console.error('Usage: memory-tree.js update <flow-id> <step>'); process.exit(1); }
      updateTree(args[0], args[1]);
      break;

    case 'generate':
      if (args.length < 2) { console.error('Usage: memory-tree.js generate <flow-id> <step>'); process.exit(1); }
      generateActiveContext(args[0], args[1]);
      break;

    case 'status':
      if (!args[0]) { console.error('Usage: memory-tree.js status <flow-id>'); process.exit(1); }
      showStatus(args[0]);
      break;

    case 'history':
      if (!args[0]) { console.error('Usage: memory-tree.js history <task-id-or-flow-id>'); process.exit(1); }
      showHistory(args[0]);
      break;

    case 'tokens':
      if (!args[0]) { console.error('Usage: memory-tree.js tokens <flow-id>'); process.exit(1); }
      showTokens(args[0]);
      break;

    default:
      console.error('Usage: memory-tree.js <init|update|generate|status|history|tokens> [args]');
      process.exit(1);
  }
}

module.exports = { initTree, updateTree, generateActiveContext, parseOutputFile, getTreePath, getActiveContextPath, getTaskDir, getFlowDir, resolveTaskId, showTokens, showHistory, migrateLegacyIfNeeded };
