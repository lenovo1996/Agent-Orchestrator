#!/usr/bin/env node
import { spawn } from 'child_process';

const MCP_PATH = '/home/ubuntu/Agent-Orchestrator/mcp/dist/index.js';

function callMcp(method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [MCP_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => stdout += d.toString());
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Exit ${code}`));
      try { resolve(JSON.parse(stdout)); }
      catch(e) { reject(new Error(`Parse error: ${stdout}`)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
      params: { name: method, arguments: params }
    }) + '\n');
    child.stdin.end();
  });
}

// Get current agents first to preserve instructions
async function getAgent(agentId) {
  const r = await callMcp('get_agents', { agentId, includeInstructions: true });
  const agents = JSON.parse(r.result.content[0].text);
  return agents;
}

const UPDATES = [
  { agentId: 'clarifier', role: 'Spec Clarifier', objective: 'Clarify spec, tìm open questions từ requirement', tools: ['read','exec','web_search','web_fetch'], outputs: ['output/clarify.md'], runtime: 'codex' },
  { agentId: 'architect', role: 'Game Architect', objective: 'Thiết kế hệ thống game cho feature phức tạp', tools: ['read','exec','grep'], outputs: ['output/architecture.md'], runtime: 'codex' },
  { agentId: 'planner', role: 'Task Planner', objective: 'Break feature thành task nhỏ, lên implementation plan', tools: ['read','exec'], outputs: ['output/plan.md'], runtime: 'codex' },
  { agentId: 'implementer', role: 'Godot Developer', objective: 'Implement feature với GDScript code và Godot scenes', tools: ['read','exec','edit','write','apply_patch'], outputs: ['output/implementation.md'], runtime: 'codex' },
  { agentId: 'verifier', role: 'Code Reviewer', objective: 'Review code quality, correctness, Godot best practices', tools: ['read','exec','grep'], outputs: ['output/review.md'], runtime: 'codex' },
];

async function main() {
  for (const upd of UPDATES) {
    console.log(`🔄 Updating ${upd.agentId}...`);
    try {
      const existing = await getAgent(upd.agentId);
      // Preserve instructions from existing agent
      await callMcp('update_agent', { ...upd, instructions: existing.instructions || '' });
      console.log(`   ✅ ${upd.agentId} → ${upd.role} (runtime: codex)`);
    } catch(e) {
      console.error(`   ❌ ${upd.agentId}: ${e.message}`);
    }
  }
  console.log('\n✅ Done!');
}

main().catch(console.error);
