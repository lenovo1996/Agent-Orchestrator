# Task Planner

## MANDATORY: Read Project Context First

**Before doing anything else, read these files to understand the project:**

1. `{{REPO_ROOT}}/AGENTS.md` — project overview, conventions, agent guidelines
2. `{{REPO_ROOT}}/.agents/rules/` — any rule files if present
3. `{{REPO_ROOT}}/.tasks/{{TASK_ID}}/summary.md` — previous knowledge about this task (if exists)
4. `{{REPO_ROOT}}/.tasks/{{TASK_ID}}/active-context.md` — compact context from prior steps (if exists, read FIRST)

Also read `output/clarify.md` from previous step.

Use `read` tool to load these files. Do not skip this step.

## Objective

Break feature thành các task nhỏ, ước lượng effort, xác định dependencies giữa các task, đề xuất thứ tự implement.

## Input

- `output/clarify.md` from Spec Clarifier (read it first)
- Repo root: `{{REPO_ROOT}}`
- Associated workspace or worktree path

## Process

### 1. Nghiên cứu codebase
- Xem cấu trúc thư mục frontend (Next.js App Router)
- Xem cấu trúc thư mục backend (AdonisJS, Containers, Actions, Routes)
- Xác định các file sẽ thay đổi

### 2. Break down tasks
Với mỗi task, ghi rõ:
- **ID**: task-01, task-02...
- **Tên**: ngắn gọn, dễ hiểu
- **Loại**: frontend | backend | database | config | docs
- **Mô tả**: ngắn gọn
- **Files cần sửa**: đường dẫn cụ thể
- **Dependencies**: task nào cần xong trước
- **Effort**: giờ (1h, 2h, 4h, 8h...)
- **Assignee gợi ý**: frontend-dev / backend-dev

### 3. Sắp xếp thứ tự
- Task nào làm trước, task nào làm sau dựa trên dependencies
- Task có thể làm song song với nhau
- Critical path là gì

### 4. Risk assessment
- Task nào có rủi ro cao (phức tạp, chưa rõ spec)
- Task nào đơn giản, có thể làm nhanh

## Output

Ghi tất cả vào file `output/plan.md`:

```markdown
# Plan: {{TASK_NAME}}

## Overview
- Tổng số task: N
- Tổng effort ước lượng: Xh
- Critical path: task-A → task-B → task-C

## Task List

### Task 01: [Tên]
- **Type**: frontend/backend/db
- **Description**: ...
- **Files**: path/to/file1.ts, path/to/file2.tsx
- **Depends on**: task-00
- **Effort**: 4h
- **Assignee**: frontend-dev
- **Risk**: Low/Medium/High

### Task 02: [Tên]
...

## Phases / Milestones
### Phase 1 (Day 1): ...
### Phase 2 (Day 2): ...
### Phase 3: ...

## Notes
- Implementation notes từ clarification
- Lưu ý cho developer
```

## Status
DONE

## IMPORTANT: Status Marker

Your output file MUST include this section near the top:

```markdown
## Status
DONE
```

If blocked (missing context, access, environment, or decision), write:

```markdown
## Status
BLOCKED
```

If you cannot complete due to technical error, write:

```markdown
## Status
FAILED
```

**Status meanings:**
- `DONE`: Step complete, can proceed
- `BLOCKED`: Missing info/access/env, needs human intervention
- `FAILED`: Technical error, will retry

Do not omit the status marker.

## Output Format

Write to `output/plan.md`:

```markdown
# Output

[Your content here]
```

