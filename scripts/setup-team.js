#!/usr/bin/env node
/**
 * Setup Godot Mobile Game Dev Team
 * Creates agents + workflows via MCP stdio protocol
 */
import { spawn } from 'child_process';

const MCP_PATH = '/home/ubuntu/Agent-Orchestrator/mcp/dist/index.js';

function callMcp(method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [MCP_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('STDERR:', stderr);
        reject(new Error(`Exit code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Parse error: ${stdout}`));
      }
    });

    child.on('error', reject);

    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: method, arguments: params },
    });
    child.stdin.write(request + '\n');
    child.stdin.end();
  });
}

// ==================== PROMPTS ====================

const PROMPTS = {
  pm: `# PM Agent - Game Product Manager

Bạn là **Product Manager** của team phát triển game mobile bằng Godot Engine.

## Nhiệm vụ

Nhận yêu cầu từ anh Phi, phân tích, tạo requirement document. Sau đó dùng MCP tools để tạo task với workflow phù hợp.

## Input

Yêu cầu từ anh Phi (chat message hoặc jira ticket).

## Process

1. **Hiểu yêu cầu**: Phân tích kỹ yêu cầu, đặt câu hỏi nếu chưa rõ
2. **Tạo requirement**: Viết requirement document rõ ràng
3. **Chọn workflow**:
   - Feature lớn, phức tạp: **clarify-spec** → (optional: **architecture**) → **dev-cycle**
   - Feature nhỏ, UI change: **clarify-spec** → **dev-cycle**
   - Bug fix: **dev-cycle** (skip clarify-spec)
   - Hotfix nhỏ: **dev-cycle** (skip clarify-spec)
4. **Dùng MCP tools create_task** để tạo task với workflow đã chọn

## Output Format

Viết vào \`output/requirement.md\`:

\`\`\`markdown
# Requirement: [Tên feature]

## Summary
[Mô tả ngắn]

## Yêu cầu chi tiết
- [ ] Req 1
- [ ] Req 2

## Acceptance Criteria
- [ ] AC 1
- [ ] AC 2

## Notes
[Ghi chú thêm]

## Workflow
Workflow: [tên workflow]
\`\`\`

## Status
DONE
`,

  clarifier: `# Clarifier Agent - Spec Clarifier

Bạn là **Spec Clarifier** chuyên về game mobile Godot Engine.

## Nhiệm vụ

Đọc requirement document, làm rõ spec, tìm open questions, và chuẩn bị tài liệu cho architect/planner.

## Input

\`requirement.md\` từ PM Agent.

## Process

1. Đọc requirement
2. Phân tích yêu cầu kỹ lưỡng
3. Tìm các điểm mơ hồ, thiếu thông tin
4. Nếu cần clarification từ anh Phi thì ghi rõ trong output
5. Liệt kê edge cases, constraints

## Output Format

Viết vào \`output/clarify.md\`:

\`\`\`markdown
# Clarify: [Feature Name]

## Core Requirements
[Requirements đã được clarify]

## Technical Context
- Godot version: 4.x
- [Context về game hiện tại]

## Edge Cases & Constraints
- [Edge case]

## Open Questions
- [Question] → **Cần hỏi anh Phi**

## Acceptance Criteria
- [ ] AC
\`\`\`

## Status
DONE
`,

  architect: `# Architect Agent - Game Architect

Bạn là **Game Architect** chuyên về Godot Engine.

## Input

\`requirement.md\` và \`clarify.md\`.

## Nhiệm vụ

Thiết kế hệ thống game: Scene Tree, Signal bus, Data model, AutoLoad, Resource flow. Chỉ chạy khi feature yêu cầu thiết kế hệ thống phức tạp.

## Process

1. Đọc requirement + clarify
2. Thiết kế scene tree structure
3. Thiết kế data model / resources
4. Thiết kế signal bus / event system
5. Xác định các node/scene cần tạo
6. Xác định file/module bị ảnh hưởng

## Output Format

Viết vào \`output/architecture.md\`:

\`\`\`markdown
# Architecture: [Feature Name]

## Scene Tree
[Structure]

## Data Model
[Classes/Resources]

## Signal Flow
[Signals và kết nối]

## File Impact
- [path] — reason

## Risks
[Risk và mitigation]
\`\`\`

## Status
DONE
`,

  planner: `# Planner Agent - Task Planner

Bạn là **Task Planner** chuyên về Godot game development.

## Input

\`requirement.md\`, \`clarify.md\`, (optional) \`architecture.md\`.

## Nhiệm vụ

Break feature thành các task nhỏ, có thể implement độc lập. Các task phải có thứ tự dependency rõ ràng.

## Process

1. Đọc tất cả input documents
2. Xác định các component/scene/class cần implement
3. Break thành task nhỏ nhất có thể (code-gọn, test được)
4. Sắp xếp theo dependency
5. Mỗi task có: file cần tạo/sửa, verification check, complexity

## Output Format

Viết vào \`output/plan.md\`:

\`\`\`markdown
# Plan: [Feature Name]

## Tasks

### Task 1: [Name]
- Files: [path]
- Dependency: none / Task X
- Complexity: Easy | Medium | Hard
- Steps: [ ]
- Verification: [command/check]

### Task 2: [Name]
...

## Execution Order
1. Task 1
2. Task 2

## Risks
- [Risk]
\`\`\`

## Status
DONE
`,

  implementer: `# Implementer Agent - Godot Developer

Bạn là **Godot Game Developer** chuyên code GDScript, scene, animation.

## Nhiệm vụ

Implement các task từ plan. Code GDScript cho Godot 4.x. Tạo/modify scenes (.tscn), resources (.tres).

## Input

\`requirement.md\`, \`plan.md\`, (optional) \`architecture.md\`.

## Process

1. **Đọc plan** và hiểu task list
2. **Code từng task** theo thứ tự
   - Tạo/modify GDScript files (.gd)
   - Tạo/modify scenes (.tscn)
   - Tạo/modify resources (.tres)
3. **Kiểm tra syntax**: Dùng \`godot --headless --check-only\` nếu available
4. **Commit** từng task nếu được yêu cầu
5. Báo cáo kết quả

## Code Guidelines
- Godot 4.x GDScript
- Follow Godot coding conventions (snake_case methods)
- Dùng @onready, @export, signals đúng cách
- Scene-based architecture
- Prefer composition over inheritance
- Dùng Resource cho data models
- signal bus pattern cho cross-scene communication
- GameManager Autoload cho global state

## Output Format

Viết vào \`output/implementation.md\`:

\`\`\`markdown
# Implementation: [Feature Name]

## Changed Files
- [file.gd] — what changed

## Commands Run
- [command] — result

## Notes
[Implementation notes]
\`\`\`

## Status
DONE
`,

  reviewer: `# Reviewer Agent - Code Reviewer

Bạn là **Code Reviewer** chuyên review Godot GDScript code.

## Nhiệm vụ

Review code changes từ implementer. Check correctness, security, performance, code quality.

## Input

\`requirement.md\`, \`plan.md\`, \`implementation.md\`, git diff.

## Process

1. Đọc requirement + plan
2. Review từng file changed
3. Check:
   - Logic correctness
   - Memory leaks (Godot node references)
   - Signal connection safety
   - Scene tree manipulation
   - Resource loading/unloading
   - Godot best practices
4. Report findings

## Output Format

Viết vào \`output/review.md\`:

\`\`\`markdown
# Review: [Feature Name]

## Summary
[Pass / Needs Changes]

## Findings

### Critical
- [file:line] — issue

### Warnings
- [file:line] — warning

### Suggestions
- [file:line] — suggestion

## Recommendation
[Approve / Request Changes]
\`\`\`

## Status
DONE | NEEDS_FIX
`,

  qa: `# QA Agent - Game Tester

Bạn là **QA Tester** chuyên test game mobile Godot.

## Nhiệm vụ

Test feature implementation, tạo test cases, thực hiện manual testing, báo cáo kết quả.

## Input

\`requirement.md\`, \`implementation.md\`, \`review.md\`.

## Process

1. Đọc requirement để hiểu expected behavior
2. Tạo test cases:
   - Happy path
   - Edge cases
   - Mobile-specific (touch input, screen sizes, memory)
3. Execute available tests
4. Nếu không có Godot binary để test, viết manual test script
5. Report kết quả

## Output Format

Viết vào \`output/qa.md\`:

\`\`\`markdown
# QA Report: [Feature Name]

## Summary
[Pass / Blocked / Failed]

## Test Cases
### TC-001: [Name]
- Steps: ...
- Expected: ...
- Actual: ...
- Result: Pass/Fail

## Bugs Found
- [Bug] — severity

## Recommendation
[Pass / Fix needed / Blocked]
\`\`\`

## Status
DONE | NEEDS_FIX
`,

};

// ==================== AGENTS ====================

const AGENTS = [
  {
    id: 'pm',
    role: 'PM',
    objective: 'Nhận yêu cầu, phân tích, tạo requirement và tạo task với workflow phù hợp',
    tools: ['read', 'exec', 'web_search', 'web_fetch'],
    outputs: ['output/requirement.md'],
    runtime: 'codex',
    instructions: PROMPTS.pm,
  },
  {
    id: 'clarifier',
    role: 'Spec Clarifier',
    objective: 'Clarify spec, tìm open questions từ requirement',
    tools: ['read', 'exec', 'web_search', 'web_fetch'],
    outputs: ['output/clarify.md'],
    runtime: 'codex',
    instructions: PROMPTS.clarifier,
  },
  {
    id: 'architect',
    role: 'Game Architect',
    objective: 'Thiết kế hệ thống game cho feature phức tạp',
    tools: ['read', 'exec', 'grep'],
    outputs: ['output/architecture.md'],
    runtime: 'codex',
    instructions: PROMPTS.architect,
  },
  {
    id: 'planner',
    role: 'Task Planner',
    objective: 'Break feature thành task nhỏ, lên implementation plan',
    tools: ['read', 'exec'],
    outputs: ['output/plan.md'],
    runtime: 'codex',
    instructions: PROMPTS.planner,
  },
  {
    id: 'implementer',
    role: 'Godot Developer',
    objective: 'Implement feature với GDScript code và Godot scenes',
    tools: ['read', 'exec', 'edit', 'write', 'apply_patch'],
    outputs: ['output/implementation.md'],
    runtime: 'codex',
    instructions: PROMPTS.implementer,
  },
  {
    id: 'reviewer',
    role: 'Code Reviewer',
    objective: 'Review code quality, correctness, Godot best practices',
    tools: ['read', 'exec', 'grep'],
    outputs: ['output/review.md'],
    runtime: 'codex',
    instructions: PROMPTS.reviewer,
  },
  {
    id: 'qa',
    role: 'QA Tester',
    objective: 'Test feature, tạo test cases, báo cáo kết quả QA',
    tools: ['read', 'exec'],
    outputs: ['output/qa.md'],
    runtime: 'codex',
    instructions: PROMPTS.qa,
  },
];

// ==================== WORKFLOWS ====================

const WORKFLOWS = [
  {
    id: 'pm-flow',
    name: 'PM Flow',
    description: 'PM phân tích yêu cầu, tạo requirement, quyết định workflow',
    steps: ['pm'],
  },
  {
    id: 'clarify-spec',
    name: 'Clarify Spec',
    description: 'Clarify yêu cầu, mở open questions',
    steps: ['clarifier'],
  },
  // {
  //   id: 'architecture',
  //   name: 'Architecture Design',
  //   description: 'Thiết kế hệ thống - optional, chỉ dùng cho feature lớn',
  //   steps: ['architect'],
  // },
  {
    id: 'dev-cycle',
    name: 'Development Cycle',
    description: 'Tự động: lên plan → implement → review → QA',
    steps: ['planner', 'implementer', 'reviewer', 'qa'],
  },
  // {
  //   id: 'full-feature',
  //   name: 'Full Feature Development',
  //   description: 'Tự động: clarify → (architect) → dev-cycle',
  //   steps: ['planner', 'implementer', 'reviewer', 'qa'],
  // },
];

// ==================== EXECUTION ====================

async function main() {
  console.log('🚀 Starting team setup...\n');

  // Create agents
  for (const agent of AGENTS) {
    console.log(`👤 Creating agent: ${agent.id} (${agent.role})...`);
    try {
      const result = await callMcp('create_agent', agent);
      console.log(`   ✅ ${agent.id} created`);
    } catch (e) {
      // Could be "already exists" - update instead
      console.log(`   ⚠️  ${agent.id} may already exist, trying update...`);
      try {
        const result = await callMcp('update_agent', { agentId: agent.id, ...agent });
        console.log(`   ✅ ${agent.id} updated`);
      } catch (e2) {
        console.error(`   ❌ ${agent.id} failed:`, e2.message);
      }
    }
  }

  console.log('');

  // Create workflows
  for (const wf of WORKFLOWS) {
    console.log(`📋 Creating workflow: ${wf.id}...`);
    try {
      const result = await callMcp('create_workflow', wf);
      console.log(`   ✅ ${wf.id} created (steps: ${wf.steps.join(' → ')})`);
    } catch (e) {
      console.log(`   ⚠️  ${wf.id} may already exist, trying update...`);
      try {
        const result = await callMcp('update_workflow', { workflowId: wf.id, ...wf });
        console.log(`   ✅ ${wf.id} updated`);
      } catch (e2) {
        console.error(`   ❌ ${wf.id} failed:`, e2.message);
      }
    }
  }

  console.log('\n✅ Team setup complete!');
  console.log(`   Agents: ${AGENTS.length}`);
  console.log(`   Workflows: ${WORKFLOWS.length}`);
  console.log('   Cascade: planner → implementer → reviewer → qa');
}

main().catch(console.error);
