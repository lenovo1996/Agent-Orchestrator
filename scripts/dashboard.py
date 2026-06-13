#!/usr/bin/env python3
"""Pretty terminal dashboard for dev-team workflows."""

import json
import os
import signal
import sys
import time
from pathlib import Path
from datetime import datetime
try:
    import wcwidth
except ImportError:
    class _WcwidthFallback:
        @staticmethod
        def wcswidth(s):
            return len(str(s))
        @staticmethod
        def wcwidth(ch):
            return 1
    wcwidth = _WcwidthFallback()

STEPS = [
    ("clarifier", "🔍", "Clarifier"),
    ("architect", "🏗️", "Architect"),
    ("planner", "📐", "Planner"),
    ("implementer", "💻", "Implementer"),
    ("verifier", "✅", "Verifier"),
]

SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
SPINNER_INDEX = 0
SUMMARY_CACHE = {}
TOKEN_CACHE = {}
LAST_SCREEN = None
LAST_SPINNER_TS = 0.0

STATUS_ICON = {
    "waiting": "⏳",
    "pending": "🕓",
    "running": "🚀",
    "done": "✅",
    "failed": "❌",
    "blocked": "🚧",
    "cancelled": "🛑",
}

STATUS_COLOR = {
    "waiting": "\033[90m",
    "pending": "\033[93m",
    "running": "\033[96m",
    "done": "\033[92m",
    "failed": "\033[91m",
    "blocked": "\033[95m",
    "cancelled": "\033[90m",
}

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
BLUE = "\033[94m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"

# Track terminal size for resize detection
LAST_TERM_SIZE = (0, 0)
RESIZE_PENDING = False


def reset_terminal_input_modes():
    """Disable terminal input modes that can leak raw escape sequences into pane."""
    # Disable mouse tracking variants + bracketed paste + show cursor + use alternate screen buffer.
    sys.stdout.write(
        "\033[?1049h"  # Switch to alternate screen buffer (no scrollback)
        "\033[?1000l"  # X10 mouse
        "\033[?1002l"  # button-event mouse
        "\033[?1003l"  # any-event mouse
        "\033[?1006l"  # SGR mouse
        "\033[?1015l"  # urxvt mouse
        "\033[?2004l"  # bracketed paste
        "\033[?25h"    # show cursor
    )
    sys.stdout.flush()


def restore_terminal():
    """Restore terminal to normal state (leave alternate screen buffer)."""
    sys.stdout.write(
        "\033[?1049l"  # Leave alternate screen buffer (restores scrollback)
        "\033[?25h"    # show cursor
    )
    sys.stdout.flush()


def clear():
    global RESIZE_PENDING, LAST_TERM_SIZE
    cols, rows = term_size()
    if (cols, rows) != LAST_TERM_SIZE or RESIZE_PENDING:
        # Full clear on resize to avoid ghost artifacts
        sys.stdout.write("\033[2J\033[H")
        LAST_TERM_SIZE = (cols, rows)
        RESIZE_PENDING = False
    else:
        # Cursor home without full clear (reduces flicker on normal refresh)
        sys.stdout.write("\033[H")


def term_size():
    try:
        sz = os.get_terminal_size()
        return (sz.columns, sz.lines)
    except OSError:
        return (120, 40)


def term_width():
    return term_size()[0]


def display_width(s):
    # Terminal cell width, handles emoji/CJK/ANSI-stripped strings.
    return wcwidth.wcswidth(str(s))

def pad_display(s, width):
    s = str(s)
    pad = width - display_width(strip_ansi(s))
    return s + (" " * max(0, pad))

def trunc(s, n):
    s = str(s)
    if display_width(strip_ansi(s)) <= n:
        return s
    out = ""
    used = 0
    limit = max(0, n - 1)
    for ch in s:
        ch_w = wcwidth.wcwidth(ch)
        if ch_w < 0:
            ch_w = 0
        if used + ch_w > limit:
            break
        out += ch
        used += ch_w
    return out + "…"

def strip_ansi(s):
    s = str(s)
    for c in list(STATUS_COLOR.values()) + [RESET, BOLD, DIM, BLUE, GREEN, YELLOW, RED, CYAN]:
        s = s.replace(c, "")
    return s


def read_workflow(work_dir):
    p = work_dir / "workflow.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


def parse_token_number(s):
    """Parse token number string with comma or dot thousands separator."""
    s = s.strip()
    if not s or s == '0':
        return 0
    import re
    comma_count = s.count(',')
    dot_count = s.count('.')
    if comma_count > 0 and dot_count == 0:
        return int(s.replace(',', '')) if s.replace(',', '').isdigit() else 0
    if dot_count > 0 and comma_count == 0:
        if re.match(r'^\d{1,3}(\.\d{3})+$', s):
            return int(s.replace('.', ''))
        return int(s.split('.')[0]) if s.split('.')[0].isdigit() else 0
    cleaned = re.sub(r'[,.\s]', '', s)
    return int(cleaned) if cleaned.isdigit() else 0


def get_step_tokens(work_dir, step):
    """Parse all 'tokens used' entries from a step's log file.
    Returns (entries_list, total).
    Uses cache keyed by (path, mtime, size) to avoid re-reading unchanged logs.
    """
    log_file = work_dir / "logs" / f"{step}.log"
    if not log_file.exists():
        return ([], 0)
    try:
        st = log_file.stat()
        key = (str(log_file), st.st_mtime_ns, st.st_size)
        cached = TOKEN_CACHE.get(str(log_file))
        if cached and cached[0] == key:
            return cached[1]
        content = log_file.read_text(errors='ignore')
    except Exception:
        return ([], 0)
    lines = content.split('\n')
    entries = []
    for i, line in enumerate(lines):
        if line.strip() == 'tokens used' and i + 1 < len(lines):
            val = parse_token_number(lines[i + 1])
            entries.append(val)
    total = sum(entries)
    result = (entries, total)
    TOKEN_CACHE[str(log_file)] = (key, result)
    return result


def format_tokens(n):
    """Format token count for display."""
    if n == 0:
        return "—"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def output_file(work_dir, step):
    name = {
        "clarifier": "clarify.md",
        "architect": "architecture.md",
        "planner": "plan.md",
        "implementer": "implementation.md",
        "verifier": "verification.md",
    }[step]
    return work_dir / "output" / name


def file_summary(p):
    if not p.exists():
        return "waiting for output"
    try:
        st = p.stat()
        key = (str(p), st.st_mtime_ns, st.st_size)
        cached = SUMMARY_CACHE.get(str(p))
        if cached and cached[0] == key:
            return cached[1]
        # Read only small head, enough for dashboard summary.
        with p.open("r", errors="ignore") as f:
            lines = []
            for _ in range(40):
                line = f.readline()
                if not line:
                    break
                lines.append(line.rstrip("\n"))
    except Exception:
        return "output exists"
    summary = "output empty"
    for line in lines:
        line = line.strip()
        if line.startswith("# "):
            summary = line[2:]
            break
    else:
        for line in lines:
            line = line.strip()
            if line:
                summary = line
                break
    SUMMARY_CACHE[str(p)] = (key, summary)
    return summary


def box(title, body_lines, width):
    inner = width - 2
    print("┌" + "─" * inner + "┐")
    title = trunc(title, inner)
    print("│" + pad_display(title, inner) + "│")
    print("├" + "─" * inner + "┤")
    for line in body_lines:
        raw = trunc(line, inner)
        print("│" + pad_display(raw, inner) + "│")
    print("└" + "─" * inner + "┘")


def render(flow_id, work_dir, script_dir):
    global SPINNER_INDEX, LAST_SPINNER_TS
    wf = read_workflow(work_dir)
    clear()
    width = term_width()
    _, height = term_size()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    # Throttle spinner update to ~5 FPS (0.2s) to reduce redraw frequency
    current_time = time.time()
    if current_time - LAST_SPINNER_TS >= 0.2:
        SPINNER_INDEX += 1
        LAST_SPINNER_TS = current_time
    spinner = SPINNER_FRAMES[SPINNER_INDEX % len(SPINNER_FRAMES)]
    pulse = [CYAN, BLUE, CYAN, GREEN][SPINNER_INDEX % 4]

    if not wf:
        print(f"{RED}Workflow not found:{RESET} {work_dir}")
        return

    # Header — compact 2 lines
    print(f"{BOLD}{CYAN}Dev Team Dashboard{RESET}  {DIM}{now}{RESET}")
    jira = wf.get('jiraKey', '')
    wf_status = wf.get('status', '')
    current = wf.get('currentStep', '')
    print(f"Flow: {BOLD}{flow_id}{RESET}  Jira: {BOLD}{jira}{RESET}  Status: {BOLD}{wf_status}{RESET}  Step: {BOLD}{current}{RESET}")
    if wf.get("customPrompt"):
        print(f"Prompt: {YELLOW}{trunc(wf['customPrompt'], width - 10)}{RESET}")
    print()

    # Progress bar — single line
    done = 0
    for step, _, _ in STEPS:
        p = output_file(work_dir, step)
        if p.exists():
            done += 1
    total = len(STEPS)
    bar_w = min(40, max(15, width - 25))
    filled = int(bar_w * done / total)
    bar = GREEN + "█" * filled + RESET + DIM + "░" * (bar_w - filled) + RESET
    print(f"[{bar}] {done}/{total}")
    print()

    # Agent status table — compact single-line per agent
    if width >= 70:
        # Wide mode: full table with aligned columns using visual-width padding
        # Calculate column widths based on available space
        col_name = 16   # "🔍 Clarifier  " (emoji=2 + space + name + pad)
        col_status = 13  # "🚀 running  "
        col_tokens = 10  # "253.4K  "
        col_file = 20   # "implementation.md"
        col_time = 10   # "14:20:01  "
        used = col_name + col_status + col_tokens + col_file + col_time + 5  # 5 for separators
        col_info = max(0, width - used - 2)

        # Header
        hdr_name = pad_display(f"{DIM}Agent{RESET}", col_name)
        hdr_status = pad_display(f"{DIM}Status{RESET}", col_status)
        hdr_tokens = pad_display(f"{DIM}Tokens{RESET}", col_tokens)
        hdr_file = pad_display(f"{DIM}Output{RESET}", col_file)
        hdr_time = pad_display(f"{DIM}Time{RESET}", col_time)
        hdr_info = f"{DIM}Info{RESET}" if col_info > 0 else ""
        print(f" {hdr_name} {hdr_status} {hdr_tokens} {hdr_file} {hdr_time} {hdr_info}")
        print(f" {DIM}{'─' * min(width - 2, col_name + col_status + col_tokens + col_file + col_time + col_info + 5)}{RESET}")

        flow_total_tokens = 0
        for step, emoji, label in STEPS:
            raw_status = wf.get("steps", {}).get(step, "waiting")
            status = raw_status.get("status", "waiting") if isinstance(raw_status, dict) else raw_status
            p = output_file(work_dir, step)
            if p.exists() and status not in ["running", "failed", "blocked", "cancelled"]:
                status = "done"
            icon = spinner if status == "running" else STATUS_ICON.get(status, "•")
            color = pulse if status == "running" else STATUS_COLOR.get(status, "")

            # Token usage
            token_entries, token_total = get_step_tokens(work_dir, step)
            flow_total_tokens += token_total
            if token_total > 0:
                token_str = format_tokens(token_total)
                # Count non-zero sessions as actual runs
                real_sessions = sum(1 for e in token_entries if e > 0)
                retry_mark = f" ({real_sessions})" if real_sessions > 1 else ""
                token_cell = f"{YELLOW}{token_str}{RESET}{DIM}{retry_mark}{RESET}"
            else:
                token_cell = f"{DIM}—{RESET}"

            if p.exists():
                mtime_ts = p.stat().st_mtime
                mtime = datetime.fromtimestamp(mtime_ts).strftime("%H:%M:%S")
                age = time.time() - mtime_ts
                flash = f" {YELLOW}✨{RESET}" if age < 5 else ""
                sz = p.stat().st_size
                if sz < 1024:
                    size_str = f"{sz}B"
                elif sz < 1024 * 1024:
                    size_str = f"{sz // 1024}KB"
                else:
                    size_str = f"{sz // (1024*1024)}MB"
                file_cell = f"{p.name}"
            else:
                mtime = "—"
                flash = ""
                file_cell = "—"

            # Build each cell with proper visual-width padding
            name_cell = pad_display(f"{emoji} {label}", col_name)
            status_cell = pad_display(f"{color}{icon} {status}{RESET}{flash}", col_status)
            token_cell_padded = pad_display(token_cell, col_tokens)
            file_cell_padded = pad_display(file_cell, col_file)
            time_cell = pad_display(mtime, col_time)

            if col_info > 0:
                summary = trunc(file_summary(p), col_info)
                info_cell = f"{DIM}{summary}{RESET}"
            else:
                info_cell = ""

            print(f" {name_cell} {status_cell} {token_cell_padded} {file_cell_padded} {time_cell} {info_cell}")

        # Token total line
        print(f" {DIM}{'─' * min(width - 2, col_name + col_status + col_tokens + col_file + col_time + col_info + 5)}{RESET}")
        if flow_total_tokens > 0:
            total_label = pad_display(f"💰 Total", col_name)
            total_exact = f"{flow_total_tokens:,}"
            total_val = f"{BOLD}{YELLOW}{total_exact}{RESET}"
            total_val_padded = pad_display(total_val, col_status + col_tokens + 1)
            print(f" {total_label} {total_val_padded}")
        print()

    else:
        # Narrow mode: minimal (name + status + tokens)
        flow_total_tokens = 0
        for step, emoji, label in STEPS:
            raw_status = wf.get("steps", {}).get(step, "waiting")
            status = raw_status.get("status", "waiting") if isinstance(raw_status, dict) else raw_status
            p = output_file(work_dir, step)
            if p.exists() and status not in ["running", "failed", "blocked", "cancelled"]:
                status = "done"
            icon = spinner if status == "running" else STATUS_ICON.get(status, "•")
            color = pulse if status == "running" else STATUS_COLOR.get(status, "")
            token_entries, token_total = get_step_tokens(work_dir, step)
            flow_total_tokens += token_total
            real_sessions = sum(1 for e in token_entries if e > 0)
            retry_mark = f" ({real_sessions})" if real_sessions > 1 else ""
            token_str = f" {YELLOW}{format_tokens(token_total)}{RESET}{DIM}{retry_mark}{RESET}" if token_total > 0 else ""
            name_cell = pad_display(f"{emoji} {label}", 16)
            print(f" {name_cell} {color}{icon} {status}{RESET}{token_str}")
        if flow_total_tokens > 0:
            print(f" {DIM}{'─' * 30}{RESET}")
            print(f" 💰 Total: {BOLD}{YELLOW}{flow_total_tokens:,}{RESET}")

    print()
    # Footer
    if wf.get("blockedStep"):
        print(f" {RED}⚠ Blocked: {wf['blockedStep']} — {wf.get('blockedReason','')}{RESET}")
    print(f" {DIM}workdir: {work_dir}{RESET}")
    print(f" {DIM}Ctrl+C to quit{RESET}")


def make_box_lines(title, body_lines, width, border_color=RESET):
    inner = width - 2
    out = []
    out.append(border_color + "┌" + "─" * inner + "┐" + RESET)
    title = trunc(title, inner)
    out.append(border_color + "│" + RESET + pad_display(title, inner) + border_color + "│" + RESET)
    out.append(border_color + "├" + "─" * inner + "┤" + RESET)
    for line in body_lines:
        raw = trunc(line, inner)
        out.append(border_color + "│" + RESET + pad_display(raw, inner) + border_color + "│" + RESET)
    out.append(border_color + "└" + "─" * inner + "┘" + RESET)
    return out


def main():
    if len(sys.argv) < 2:
        print("Usage: dashboard.py <flow-id> [interval-seconds]")
        sys.exit(1)
    flow_id = sys.argv[1]
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 3  # Slower refresh = less flicker
    # Derive repo root from script location
    script_dir = Path(__file__).parent.resolve()
    repo_root = script_dir.parent.parent
    work_dir = repo_root / '.dev-team/task-flows' / flow_id
    import io
    import contextlib
    global LAST_SCREEN, RESIZE_PENDING

    def handle_sigwinch(signum, frame):
        global RESIZE_PENDING, LAST_SCREEN
        RESIZE_PENDING = True
        LAST_SCREEN = None  # Invalidate cache to force redraw

    signal.signal(signal.SIGWINCH, handle_sigwinch)

    try:
        reset_terminal_input_modes()
        # Initial full clear
        sys.stdout.write("\033[2J\033[H")
        sys.stdout.flush()
        while True:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                render(flow_id, work_dir, script_dir)
            screen = buf.getvalue()
            # Only write to terminal when visual content changed.
            if screen != LAST_SCREEN:
                reset_terminal_input_modes()
                # Erase from cursor to end of screen to clear stale lines
                sys.stdout.write(screen + "\033[J")
                sys.stdout.flush()
                LAST_SCREEN = screen
            time.sleep(interval)
    except KeyboardInterrupt:
        restore_terminal()
        print("\nbye")
    finally:
        restore_terminal()


if __name__ == "__main__":
    main()
