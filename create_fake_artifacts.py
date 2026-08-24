#!/usr/bin/env python3
"""
Create filesystem artifacts for fake flows so the server doesn't throw ENOENT errors.
Structure per flow:
  $TASK_FLOWS_DIR/{workspace_id}/{flow_id}/
    output/{step}.md
    logs/{step}.log
    sessions/{step}/          (empty dir, server watches this)
"""

import sqlite3
import os
import random

DB_PATH = "/Users/phi/Workplace/phi/Agent-Orchestrator/workflows.db"
TASK_FLOWS_DIR = "/Users/phi/Workplace/phi/.dev-team/task-flows"
WORKSPACE_ID = "ws_fake_demo_001"

# ── fake output templates per agent role ──────────────────────────────────────
OUTPUT_TEMPLATES = {
    "investigator": """\
# Investigation Report

## Summary
Conducted thorough investigation of the reported issue. Identified root cause in the authentication middleware.

## Root Cause
The null pointer exception occurs when `user.session` is accessed before initialization during concurrent requests.

## Affected Files
- `src/middleware/auth.ts` (line 84)
- `src/utils/session.ts` (line 31)

## Recommendation
Add null check before accessing `user.session` and initialize session object in constructor.
""",
    "fix_planner": """\
# Fix Plan

## Objective
Fix null pointer exception in auth middleware identified in investigation.

## Implementation Steps
1. Add null guard in `src/middleware/auth.ts:84`
2. Initialize session in `UserSession` constructor
3. Add unit test for concurrent session access
4. Run integration tests

## Risk Assessment
- Low risk change, isolated to auth middleware
- Existing tests cover happy path
""",
    "fix_implementer": """\
# Implementation Notes

## Changes Made

### src/middleware/auth.ts
- Added null check before accessing `user.session`
- Added early return with 401 response if session is missing

### src/utils/session.ts
- Initialized `session` property in constructor to empty object
- Added `isValid()` helper method

## Testing
All existing unit tests pass. Added 2 new test cases for edge conditions.
""",
    "bug_verifier": """\
# Verification Report

## Status: ✅ PASSED

## Test Results
- Unit tests: 47/47 passed
- Integration tests: 12/12 passed
- Manual verification: Confirmed fix resolves NPE

## Performance
No regression detected. Response time within acceptable range.

## Conclusion
Fix is correct and complete. Ready for review.
""",
    "analyzer": """\
# Analysis Report

## Codebase Overview
Analyzed the target module and identified areas for improvement.

## Key Findings
1. Code duplication in service layer (~15% redundancy)
2. Missing error handling in 3 critical paths
3. Opportunity for async optimization

## Recommendations
- Extract common utilities to shared module
- Implement retry logic for external service calls
- Add structured logging
""",
    "refactor-planner": """\
# Refactor Plan

## Goals
- Reduce code duplication by 60%
- Improve maintainability score
- Maintain 100% backward compatibility

## Approach
1. Extract base service class
2. Move shared utilities to `src/utils/common.ts`
3. Standardize error handling pattern
4. Update all callers

## Estimated Effort
Medium - 2-3 hours of implementation
""",
    "refactor-implementer": """\
# Refactor Implementation

## Changes Summary
- Created `BaseService` abstract class with shared methods
- Moved 8 utility functions to `src/utils/common.ts`
- Updated 12 files to use new shared utilities
- Standardized error handling across all services

## Files Modified
- `src/services/base.ts` [NEW]
- `src/utils/common.ts` [MODIFIED]
- `src/services/*.ts` [12 files updated]
""",
    "planner": """\
# Task Plan

## Objective
Implement the requested feature according to specifications.

## Implementation Steps
1. Set up data models and interfaces
2. Implement core business logic
3. Add API endpoints
4. Write unit and integration tests
5. Update documentation

## Dependencies
None - can proceed immediately.
""",
    "implementer": """\
# Implementation Complete

## What Was Built
Successfully implemented all planned features:
- Core business logic in service layer
- REST API endpoints with proper validation
- Error handling and logging
- Database queries optimized with indexes

## Test Coverage
- 94% line coverage
- All edge cases handled
""",
    "verifier": """\
# Verification Complete

## Status: ✅ ALL CHECKS PASSED

## Checklist
- [x] Unit tests passing (52/52)
- [x] Integration tests passing (8/8)
- [x] Code review guidelines met
- [x] No security vulnerabilities detected
- [x] Performance benchmarks within threshold

## Sign-off
Implementation is complete and verified. Ready to merge.
""",
    "clarifier": """\
# Specification Clarification

## Original Request
Reviewed and clarified the requirements with the team.

## Clarified Requirements
1. Feature scope: Limited to backend API changes only
2. Authentication: Use existing JWT middleware
3. Data retention: 90-day default, configurable per tenant
4. Rate limiting: 100 req/min per user

## Open Questions Resolved
All questions resolved. Proceeding with implementation.
""",
    "architect": """\
# Solution Architecture

## Overview
Designed a scalable solution using event-driven architecture.

## Components
- **API Gateway**: Rate limiting + auth validation
- **Event Bus**: Async message passing (Redis Streams)
- **Service Layer**: Domain-driven design
- **Data Layer**: PostgreSQL with read replicas

## Trade-offs
Chose eventual consistency over strong consistency for better scalability.
Performance: ~2ms p99 latency at 10k RPS.
""",
}

LOG_TEMPLATE = """\
[{ts}] Starting {step} agent...
[{ts}] Loaded context from previous steps
[{ts}] Analyzing codebase structure...
[{ts}] Processing task requirements...
[{ts}] Generating solution...
[{ts}] Writing output to {output_path}
[{ts}] Tokens used: input={inp}, output={out}, cache_read={cache}
[{ts}] Step completed successfully
"""

def fake_log(step, output_path, started_at):
    ts = started_at[:19].replace("T", " ")
    inp = random.randint(8000, 45000)
    out = random.randint(1000, 8000)
    cache = random.randint(0, inp // 2)
    return LOG_TEMPLATE.format(
        ts=ts, step=step, output_path=output_path,
        inp=inp, out=out, cache=cache
    )


def create_artifacts():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    flows = cur.execute(
        "SELECT id FROM flows WHERE workspace_id = ?", (WORKSPACE_ID,)
    ).fetchall()

    created = 0
    for (flow_id,) in flows:
        steps = cur.execute(
            "SELECT step, output_path, started_at FROM flow_steps WHERE flow_id = ? ORDER BY position",
            (flow_id,)
        ).fetchall()

        flow_dir = os.path.join(TASK_FLOWS_DIR, WORKSPACE_ID, flow_id)

        for (step, output_path, started_at) in steps:
            # ── output file ──
            output_file = os.path.join(flow_dir, output_path or f"output/{step}.md")
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            if not os.path.exists(output_file):
                template_key = step.replace("-", "_")
                content = OUTPUT_TEMPLATES.get(template_key, OUTPUT_TEMPLATES.get(step, f"# {step}\n\nCompleted successfully.\n"))
                with open(output_file, "w") as f:
                    f.write(content)

            # ── log file ──
            log_file = os.path.join(flow_dir, "logs", f"{step}.log")
            os.makedirs(os.path.dirname(log_file), exist_ok=True)
            if not os.path.exists(log_file):
                with open(log_file, "w") as f:
                    f.write(fake_log(step, output_path or f"output/{step}.md", started_at or "2026-08-01T10:00:00Z"))

            # ── sessions dir (server watches this) ──
            session_dir = os.path.join(flow_dir, "sessions", step)
            os.makedirs(session_dir, exist_ok=True)

        created += 1
        print(f"  ✅ {flow_id}  ({len(steps)} steps)")

    conn.close()
    print(f"\n✅ Created artifacts for {created} flows under {TASK_FLOWS_DIR}/{WORKSPACE_ID}/")


if __name__ == "__main__":
    print(f"📁 Creating filesystem artifacts for fake flows...\n")
    create_artifacts()
