# Agent Runtimes

Pluggable runtime system cho dev-team pipeline. Mỗi runtime là một shell script xử lý việc gọi CLI agent cụ thể.

## Cấu hình

Trong `team.json`:

```json
{
  "defaultRuntime": "codex",
  "members": {
    "clarifier": {
      "runtime": "claude",
      "model": "claude-sonnet-4-20250514"
    },
    "implementer": {
      "runtime": "codex",
      "model": "gpt-5.5",
      "thinking": "high"
    },
    "reviewer": {
      "runtime": "kiro"
    }
  }
}
```

## Available Runtimes

| Runtime | CLI | Token Format | Notes |
|---------|-----|--------------|-------|
| `codex` | OpenAI Codex CLI | `tokens used\n<number>` | Default. Headless exec mode |
| `claude` | Claude Code CLI | JSON `{"usage":{"input_tokens":N,"output_tokens":N}}` | Uses `-p` print mode |
| `kiro` | Kiro CLI | `Token usage: <number>` | Headless mode |
| `opencode` | OpenCode CLI (via Anthropic proxy) | Auto-detect | Uses anthropic-proxy.js → 9router |
| `generic` | Custom command | Auto-detect | Requires `runtimeCommand` in config |

## Interface

Mỗi runtime script nhận cùng arguments:

```
runtimes/<name>.sh <prompt-file> <log-file> <work-dir> <cwd>
```

Env vars được set bởi `agent-wrapper.sh`:
- `AGENT_RUNTIME` — tên runtime
- `AGENT_MODEL` — model name
- `AGENT_REASONING` — reasoning effort
- `AGENT_COMMAND` — custom command (generic only)
- `AGENT_PERMISSION` — permission mode (claude only)
- `AGENT_MAX_TURNS` — max turns limit

## Token Tracking

`token-tracker.js` tự động detect format từ log content:
1. Codex format: `tokens used\n250,964`
2. Claude JSON: `{"usage":{"input_tokens":N,"output_tokens":N}}`
3. Generic: `Total tokens: N` hoặc `Tokens: N`
4. Kiro: `Token usage: N`

Không cần cấu hình gì thêm — parser sẽ nhận dạng format bất kể runtime nào.

## Tạo Runtime Mới

1. Copy `generic.sh` thành `runtimes/<name>.sh`
2. Sửa command gọi CLI
3. Đảm bảo output token info theo 1 trong các format trên (hoặc thêm parser mới vào `token-tracker.js`)
4. Set `"runtime": "<name>"` trong `team.json`

## Backward Compatibility

- `codex-agent-wrapper.sh` vẫn hoạt động (legacy)
- `agent-wrapper.sh` là entry point mới, dispatch đến `runtimes/`
- Nếu không set `runtime`, default là `codex`
