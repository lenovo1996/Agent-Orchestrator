# Spec Clarifier

## MANDATORY: Read Project Context First

**Before doing anything else, read these files to understand the project:**

1. `{{REPO_ROOT}}/AGENTS.md` — project overview, conventions, agent guidelines
2. `{{REPO_ROOT}}/.agents/rules/` — any rule files if present
3. `{{REPO_ROOT}}/.tasks/{{TASK_ID}}/summary.md` — previous knowledge about this task (if exists)
4. `{{REPO_ROOT}}/.tasks/{{TASK_ID}}/active-context.md` — compact context from prior steps (if exists, read FIRST)

Use `read` tool to load these files. Do not skip this step.

## Objective

Phân tích yêu cầu (từ Jira ticket hoặc custom prompt), xác định phạm vi, tìm ra tất cả open questions trước khi team implement.

## Input

- Jira ticket: `{{JIRA_KEY}}` (nếu có)
- Custom prompt: `{{CUSTOM_PROMPT}}` (nếu có)
- Repo root: `{{REPO_ROOT}}`
- Associated workspace or worktree path

## Process

### 1. Đọc và phân tích yêu cầu
- Đọc kỹ mô tả requirement, acceptance criteria
- Xác định business context, mục tiêu của feature
- Đọc file liên quan trong codebase để hiểu context

### 2. Xác định phạm vi (Scope)
- **In scope**: những gì feature này sẽ làm
- **Out of scope**: những gì KHÔNG thuộc feature này
- **Dependencies**: các feature/service khác cần có trước

### 3. Tìm Open Questions
Với mỗi điểm mơ hồ/thiếu thông tin, ghi rõ:
- ❓ Câu hỏi
- 🎯 Tại sao cần biết (impact gì nếu quyết định sai)
- 💡 Giả định nếu không trả lời được (propose solution)

### 4. Phân tích sơ bộ kỹ thuật
- Component nào cần thay đổi/ thêm mới
- Database schema có cần thay đổi không
- API có cần endpoint mới không
- Third-party có cần tích hợp không

## Output

Ghi tất cả vào file `output/clarify.md` với format:

```markdown
# Clarify: {{TASK_NAME}}

## Summary
Tóm tắt ngắn gọn yêu cầu (2-3 câu)

## Scope
- In scope: [...]
- Out of scope: [...]
- Dependencies: [...]

## Technical Impact
- Frontend changes: [...]
- Backend changes: [...]
- Database changes: [...]
- New dependencies: [...]

## Open Questions
1. ❓ **Question?**
   - Why: ...
   - Assumption if not answered: ...

2. ❓ **Question?**
   - Why: ...
   - Assumption if not answered: ...

## Recommendations
- Đề xuất hướng giải quyết cho từng open question
- Risk assessment
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

Write to `output/clarify.md`:

```markdown
# Output

[Your content here]
```

