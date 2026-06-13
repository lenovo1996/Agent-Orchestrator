"""Output Formatter for log_pretty.

Provides the Formatter class that renders ActivityGroups, ClassifiedLines,
CollapseResults, and other elements into formatted terminal output with
Unicode box-drawing characters, ANSI colors, and proper indentation.
"""

import re
from datetime import datetime, timezone

from .cli import Config
from .classifier import ClassifiedLine, LineType
from .collapser import CollapseResult
from .colors import colorize, icon
from .grouper import ActivityGroup
from .paths import shorten_path


# ANSI escape sequence pattern for stripping
_RE_ANSI = re.compile(r"\033\[[0-9;]*m")

# Box-drawing characters
_HORIZONTAL = "─"  # U+2500
_VERTICAL = "│"  # U+2502
_CORNER_TL = "┌"  # U+250C
_CORNER_TR = "┐"  # U+2510
_CORNER_BL = "└"  # U+2514
_CORNER_BR = "┘"  # U+2518
_TEE_LEFT = "├"  # U+251C
_TEE_RIGHT = "┤"  # U+2524


def _strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences to measure visible length."""
    return _RE_ANSI.sub("", text)


def _visible_len(text: str) -> int:
    """Return the visible length of text (excluding ANSI codes)."""
    return len(_strip_ansi(text))


def _truncate_to_width(text: str, width: int) -> str:
    """Truncate text so visible length does not exceed width.

    Preserves ANSI codes but truncates visible characters,
    appending ellipsis if truncation occurs.
    """
    visible = _strip_ansi(text)
    if len(visible) <= width:
        return text

    # We need to walk through the text, tracking visible chars
    result = []
    visible_count = 0
    i = 0
    target = width - 1  # Leave room for ellipsis character

    while i < len(text) and visible_count < target:
        # Check if we're at an ANSI escape sequence
        if text[i] == "\033" and i + 1 < len(text) and text[i + 1] == "[":
            # Find end of ANSI sequence
            j = i + 2
            while j < len(text) and text[j] != "m":
                j += 1
            # Include the 'm'
            if j < len(text):
                j += 1
            result.append(text[i:j])
            i = j
        else:
            result.append(text[i])
            visible_count += 1
            i += 1

    result.append("…")
    return "".join(result)


class Formatter:
    """Formats log elements for terminal display.

    Handles section headers, output lines, group endings, collapse
    summaries, elapsed time, and startup headers. Respects no_color
    and verbose config flags and truncates output to terminal width.
    """

    def __init__(self, config: Config, terminal_width: int):
        self.config = config
        self.width = terminal_width
        self._color_enabled = not config.no_color

    def format_section_header(self, group: ActivityGroup) -> str:
        """Format a section header for an activity group.

        Produces a line with box-drawing horizontal rule, icon, command,
        and timestamp. In verbose mode, uses full ISO timestamp.

        Property 2: Contains HH:MM:SS timestamp (or ISO in verbose).
        Property 3: Uses Unicode box-drawing characters.
        Property 11: Visible length ≤ terminal_width.
        Property 18: Verbose mode → full ISO timestamp.
        """
        # Determine icon and color based on group type
        if group.group_type == "exec":
            group_icon = icon("exec")
            color_key = "exec"
        else:
            group_icon = icon("mcp")
            color_key = "mcp"

        # Format timestamp
        now = datetime.now(tz=timezone.utc)
        if self.config.verbose:
            timestamp = now.strftime("%Y-%m-%dT%H:%M:%S")
        else:
            timestamp = now.strftime("%H:%M:%S")

        # Format command text — in verbose mode show full path, otherwise shorten
        command = group.command
        if not self.config.verbose and len(command) > 50:
            command = shorten_path(command, "", max_length=50)

        # Calculate available space for command to ensure timestamp always fits
        # Minimum structure: "─── {icon} {cmd} [{timestamp}] ─"
        # icon is ~2 chars visible, brackets + spaces ~5, left line 3, right line 1, spaces 2
        timestamp_part = f"[{timestamp}]"
        fixed_overhead = 3 + 1 + 2 + 2 + len(timestamp_part) + 3  # left_line + spaces + icon + space + ts + space + min_right
        max_cmd_len = self.width - fixed_overhead
        if max_cmd_len < 3:
            max_cmd_len = 3
        if len(command) > max_cmd_len:
            command = command[: max_cmd_len - 1] + "…"

        # Build the header content
        content = f"{group_icon} {command} [{timestamp}]"
        content_colored = colorize(content, color_key, self._color_enabled)

        # Build separator line with box-drawing
        # Format: ─── content ───
        content_visible_len = _visible_len(content_colored)
        # Calculate remaining space for horizontal lines
        remaining = self.width - content_visible_len - 4  # 2 spaces + min 2 chars of line
        left_len = 3
        right_len = max(1, remaining - left_len)

        left_line = _HORIZONTAL * left_len
        right_line = _HORIZONTAL * right_len

        header = f"{left_line} {content_colored} {right_line}"

        # Truncate if needed
        header = _truncate_to_width(header, self.width)
        return header

    def format_output_line(self, line: ClassifiedLine, indent: int) -> str:
        """Format an output line within an activity group.

        Uses tree-line characters (│ for continuation, └ for last line).
        The indent parameter controls indentation depth.
        is_last should be determined by the caller; here indent > 0
        means we use │ prefix by default.

        Property 4: Greater indentation than header, contains │ or └.
        Property 10: No ANSI if no_color=True.
        Property 11: Visible length ≤ terminal_width.
        Property 14: AI response lines show 🤖 icon.
        Property 18: Verbose mode shows full paths.
        """
        # Determine tree character — use └ if indent indicates last line
        # Convention: indent=0 means last line in group (use └)
        #             indent>0 means continuation (use │)
        if indent == 0:
            tree_char = _CORNER_BL
        else:
            tree_char = _VERTICAL

        # Build indentation: spaces + tree char + space
        prefix = "  " + tree_char + " "

        # Format line content
        content = line.raw.rstrip("\n")

        # Path shortening in non-verbose mode
        if not self.config.verbose:
            # Simple path shortening for display
            pass  # Paths are shown as-is in output lines unless verbose overrides

        # Handle special line types
        if line.line_type == LineType.AI_RESPONSE:
            ai_icon = icon("ai_response")
            content = f"{ai_icon} {content}"
        elif line.line_type == LineType.ERROR:
            content = colorize(content, "failure", self._color_enabled)
        elif line.line_type == LineType.WARNING:
            content = colorize(content, "warning", self._color_enabled)
        elif line.line_type == LineType.FILE_READ:
            # Show file path — in verbose mode show full, otherwise shorten
            file_path = line.metadata.get("path", "")
            if file_path and not self.config.verbose:
                short = shorten_path(file_path, "", max_length=50)
                content = content.replace(file_path, short)

        # Color the tree prefix
        prefix_colored = colorize(prefix, "dim", self._color_enabled)

        result = f"{prefix_colored}{content}"

        # Truncate to width
        result = _truncate_to_width(result, self.width)
        return result

    def format_group_end(self, group: ActivityGroup) -> str:
        """Format the end-of-group line with status icon and duration.

        Property 5: Contains ✅ or ❌ icon and duration value.
        Property 10: No ANSI if no_color=True.
        Property 11: Visible length ≤ terminal_width.
        """
        # Determine status icon and color
        if group.status == "succeeded":
            status_icon = icon("success")
            color_key = "success"
        else:
            status_icon = icon("failure")
            color_key = "failure"

        # Calculate duration from start_time
        # Use group's collected timing if available
        import time

        elapsed = time.time() - group.start_time
        duration_str = self._format_duration(elapsed)

        # Build end line with tree corner
        content = f"  {_CORNER_BL}{_HORIZONTAL} {status_icon} {duration_str}"
        content_colored = colorize(content, color_key, self._color_enabled)

        # Truncate to width
        content_colored = _truncate_to_width(content_colored, self.width)
        return content_colored

    def format_collapse_summary(self, result: CollapseResult) -> str:
        """Format a collapse summary line.

        Property 10: No ANSI if no_color=True.
        Property 11: Visible length ≤ terminal_width.
        """
        summary_text = f"  {_VERTICAL}  ... {result.summary}"
        summary_colored = colorize(summary_text, "dim", self._color_enabled)

        # Truncate to width
        summary_colored = _truncate_to_width(summary_colored, self.width)
        return summary_colored

    def format_elapsed(self, seconds: float, warning: bool) -> str:
        """Format elapsed time, using yellow ANSI if warning (>30s).

        Property 6: elapsed > 30s → yellow ANSI (\\033[93m), ≤30s → no yellow.
        Property 10: No ANSI if no_color=True.
        Property 11: Visible length ≤ terminal_width.
        """
        # Format the elapsed time value
        if seconds < 1.0:
            elapsed_str = f"{int(seconds * 1000)}ms"
        else:
            elapsed_str = f"{seconds:.1f}s"

        text = f"⏱ {elapsed_str}"

        # Apply yellow color only if warning AND color enabled
        if warning and self._color_enabled:
            text = colorize(text, "warning", self._color_enabled)

        # Truncate to width
        text = _truncate_to_width(text, self.width)
        return text

    def format_startup_header(
        self, flow_id: str, agent_step: str, log_file: str, jira_key: str | None
    ) -> str:
        """Format the startup header box.

        Displays flow context in a Unicode box-drawing bordered box.

        Property 3: Uses Unicode box-drawing characters.
        Property 10: No ANSI if no_color=True.
        Property 11: Each line visible length ≤ terminal_width.
        Property 16: Contains flow_id, agent_step, and log_file as substrings.
        """
        # Build content lines
        lines = [
            f"Flow: {flow_id}",
            f"Step: {agent_step}",
            f"Log:  {log_file}",
        ]
        if jira_key:
            lines.append(f"Jira: {jira_key}")

        # Calculate box width — fit to content but respect terminal width
        max_content_len = max(len(line) for line in lines)
        # Box inner width: content + 2 padding spaces
        inner_width = min(max_content_len + 2, self.width - 4)
        # Ensure inner_width is at least as wide as longest content
        inner_width = max(inner_width, max_content_len + 2)

        # Build box
        top_line = f"{_CORNER_TL}{_HORIZONTAL * inner_width}{_CORNER_TR}"
        bottom_line = f"{_CORNER_BL}{_HORIZONTAL * inner_width}{_CORNER_BR}"

        result_lines = [_truncate_to_width(top_line, self.width)]

        for content_line in lines:
            # Pad content to fill the inner width
            padded = f" {content_line}".ljust(inner_width)
            box_line = f"{_VERTICAL}{padded}{_VERTICAL}"
            result_lines.append(_truncate_to_width(box_line, self.width))

        result_lines.append(_truncate_to_width(bottom_line, self.width))

        return "\n".join(result_lines)

    def _format_duration(self, seconds: float) -> str:
        """Format a duration as human-readable string."""
        if seconds < 1.0:
            return f"{int(seconds * 1000)}ms"
        elif seconds < 60.0:
            return f"{seconds:.1f}s"
        else:
            minutes = int(seconds // 60)
            secs = seconds % 60
            return f"{minutes}m{secs:.0f}s"
