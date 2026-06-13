"""Entry point for `python -m log_pretty`.

Wires all components together:
CLI → Follower → Classifier → Grouper → Collapser → Formatter → stdout
"""

import glob
import json
import os
import sys
import time

from .cli import parse_args, Config
from .follower import LogFollower
from .classifier import classify
from .grouper import ActivityGrouper, OutputEventType
from .collapser import should_collapse
from .formatter import Formatter
from .timer import ElapsedTimer
from .colors import colorize, icon


# Spinner frames for waiting animation
_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]


def _get_terminal_width() -> int:
    """Detect terminal width with fallback to 120 columns."""
    try:
        return os.get_terminal_size().columns
    except (AttributeError, ValueError, OSError):
        return 120


def _write(text: str) -> None:
    """Write text to stdout and flush immediately for real-time output."""
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def _write_inline(text: str) -> None:
    """Write text to stdout without newline (for spinners) and flush."""
    sys.stdout.write(text)
    sys.stdout.flush()


def _find_workflow_json(log_file: str) -> str | None:
    """Search for workflow.json by walking up from the log file directory.

    Also checks common locations like .dev-team/task-flows/*/workflow.json.

    Returns the path to workflow.json if found, otherwise None.
    """
    log_dir = os.path.dirname(os.path.abspath(log_file))

    # Strategy 1: Walk up from log file directory (max 5 levels)
    search_dir = log_dir
    for _ in range(5):
        candidate = os.path.join(search_dir, "workflow.json")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(search_dir)
        if parent == search_dir:
            break
        search_dir = parent

    # Strategy 2: Check .dev-team/task-flows/*/workflow.json relative to log file
    # Walk up from log_dir to find a directory containing .dev-team/
    search_dir = log_dir
    for _ in range(10):
        task_flows_dir = os.path.join(search_dir, ".dev-team", "task-flows")
        if os.path.isdir(task_flows_dir):
            # Find workflow.json files in flow directories
            pattern = os.path.join(task_flows_dir, "*", "workflow.json")
            matches = glob.glob(pattern)
            if matches:
                # Return the most recently modified workflow.json
                matches.sort(key=lambda p: os.path.getmtime(p), reverse=True)
                return matches[0]
        parent = os.path.dirname(search_dir)
        if parent == search_dir:
            break
        search_dir = parent

    return None


def _parse_workflow_json(workflow_path: str) -> dict:
    """Parse workflow.json safely, returning extracted fields.

    Returns a dict with keys: flow_id, jira_key, current_step, status.
    Missing or malformed fields are returned as empty strings or None.
    """
    result = {
        "flow_id": "",
        "jira_key": None,
        "current_step": "",
        "status": "",
    }

    try:
        with open(workflow_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return result

    if not isinstance(data, dict):
        return result

    result["flow_id"] = str(data.get("flowId", "")) or ""
    result["current_step"] = str(data.get("currentStep", "")) or ""
    result["status"] = str(data.get("status", "")) or ""

    jira_key = data.get("jiraKey")
    if jira_key and isinstance(jira_key, str):
        result["jira_key"] = jira_key

    return result


def _display_startup_header(config: Config, formatter: Formatter) -> None:
    """Display startup header with workflow context.

    Searches for workflow.json to extract flow ID, Jira key, agent step,
    and status. If workflow.json is not found, displays a minimal header
    with just the log file path.
    """
    workflow_path = _find_workflow_json(config.log_file)

    if workflow_path:
        info = _parse_workflow_json(workflow_path)
        flow_id = info["flow_id"] or "(unknown)"
        agent_step = info["current_step"] or "(unknown)"
        jira_key = info["jira_key"]
    else:
        flow_id = "(no workflow)"
        agent_step = "(unknown)"
        jira_key = None

    header = formatter.format_startup_header(
        flow_id=flow_id,
        agent_step=agent_step,
        log_file=config.log_file,
        jira_key=jira_key,
    )
    _write(header)
    _write("")


def main() -> None:
    """Main entry point for the log pretty formatter."""
    # 1. Parse CLI args → Config
    config = parse_args()

    # 2. Detect terminal width
    terminal_width = _get_terminal_width()

    # 3. Create Formatter
    formatter = Formatter(config, terminal_width)

    # 4. Create LogFollower
    follower = LogFollower(config.log_file)

    # 5. Create ActivityGrouper
    grouper = ActivityGrouper()

    # 6. Create ElapsedTimer
    timer = ElapsedTimer()

    # 7. Display startup header
    _display_startup_header(config, formatter)

    # State for collapsing logic
    group_lines: list[str] = []  # Accumulated output lines for current group
    in_group = False
    spinner_idx = 0
    color_enabled = not config.no_color

    try:
        # 8. Main loop
        for line in follower.lines():
            # Handle waiting state (file doesn't exist yet)
            if follower.on_waiting:
                spinner_char = _SPINNER_FRAMES[spinner_idx % len(_SPINNER_FRAMES)]
                spinner_idx += 1
                msg = f"\r{spinner_char} Waiting for log file: {config.log_file}"
                msg = colorize(msg, "dim", color_enabled)
                _write_inline(msg)
                time.sleep(follower.poll_interval)
                continue

            # Handle rotation notification
            if follower.on_rotation:
                _write_inline("\r" + " " * terminal_width + "\r")  # Clear spinner line
                rotation_msg = f"{icon('warning')} Log file rotated — following new file"
                rotation_msg = colorize(rotation_msg, "warning", color_enabled)
                _write(rotation_msg)

            # No new line available — poll
            if line is None:
                # Check stale timer
                if timer.start_time is not None and timer.is_stale():
                    elapsed_secs = timer.elapsed()
                    warning = timer.is_warning()
                    elapsed_str = formatter.format_elapsed(elapsed_secs, warning)
                    _write_inline(f"\r  {elapsed_str} ")
                time.sleep(follower.poll_interval)
                continue

            # Clear any inline spinner/elapsed display
            _write_inline("\r" + " " * min(terminal_width, 80) + "\r")

            # Mark output for stale detection
            timer.mark_output()

            # Classify the line
            classified = classify(line)

            # Feed to grouper → get OutputEvents
            events = grouper.feed(classified)

            # Process each output event
            for event in events:
                if event.event_type == OutputEventType.GROUP_START:
                    # Start new group — print section header
                    in_group = True
                    group_lines = []
                    timer.start()
                    header = formatter.format_section_header(event.group)
                    _write(header)

                elif event.event_type == OutputEventType.GROUP_LINE:
                    # Accumulate lines within the group
                    formatted = formatter.format_output_line(event.line, indent=1)
                    group_lines.append(formatted)
                    # In verbose mode or no-collapse, print immediately
                    if config.verbose or config.no_collapse:
                        _write(formatted)

                elif event.event_type == OutputEventType.GROUP_END:
                    # Group ended — check collapse on accumulated lines
                    if not config.verbose and not config.no_collapse:
                        # Get raw output lines for collapse decision
                        # Skip first line (the start marker) and empty lines
                        output_raws = []
                        if event.group and event.group.lines:
                            output_raws = [
                                cl.raw for cl in event.group.lines[1:]
                                if cl.raw.strip()
                            ]

                        collapse_result = should_collapse(output_raws, config)

                        if collapse_result.collapsed:
                            # Print preview lines (first 2 formatted)
                            for preview_line in group_lines[:2]:
                                _write(preview_line)
                            # Print collapse summary
                            summary = formatter.format_collapse_summary(collapse_result)
                            _write(summary)
                        else:
                            # Print all accumulated lines
                            for accumulated_line in group_lines:
                                _write(accumulated_line)

                    # Print group end line
                    if event.group:
                        end_line = formatter.format_group_end(event.group)
                        _write(end_line)

                    # Reset group state
                    in_group = False
                    group_lines = []
                    timer.reset()

                elif event.event_type == OutputEventType.STANDALONE:
                    # Print standalone line directly
                    formatted = formatter.format_output_line(event.line, indent=0)
                    _write(formatted)

    except KeyboardInterrupt:
        # Graceful shutdown
        _write_inline("\r" + " " * min(terminal_width, 80) + "\r")

        # Flush any open group
        flush_events = grouper.flush()
        for event in flush_events:
            if event.event_type == OutputEventType.GROUP_END and event.group:
                # Print any remaining accumulated lines
                if group_lines and not config.no_collapse:
                    if event.group.lines:
                        output_raws = [
                            cl.raw for cl in event.group.lines[1:]
                            if cl.raw.strip()
                        ]
                        collapse_result = should_collapse(output_raws, config)
                        if collapse_result.collapsed:
                            for preview_line in group_lines[:2]:
                                _write(preview_line)
                            summary = formatter.format_collapse_summary(collapse_result)
                            _write(summary)
                        else:
                            for accumulated_line in group_lines:
                                _write(accumulated_line)
                elif group_lines:
                    for accumulated_line in group_lines:
                        _write(accumulated_line)

                end_line = formatter.format_group_end(event.group)
                _write(end_line)

        # Close the follower
        follower.close()

        # Print exit message
        exit_msg = colorize("\n👋 Interrupted — exiting gracefully.", "dim", color_enabled)
        _write(exit_msg)
        sys.exit(0)


if __name__ == "__main__":
    main()
