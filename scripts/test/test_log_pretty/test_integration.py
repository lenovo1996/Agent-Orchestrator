"""End-to-end integration test for the log_pretty pipeline.

Exercises the full pipeline: classify → group → collapse → format
without using the follower (to avoid blocking).
"""

import re

from log_pretty.classifier import classify, LineType
from log_pretty.cli import Config
from log_pretty.collapser import should_collapse
from log_pretty.formatter import Formatter
from log_pretty.grouper import ActivityGrouper, OutputEventType


# Sample log content simulating a real agent log session
SAMPLE_LOG = """\
exec
/usr/bin/zsh -lc "composer require some/package" in /home/user/project
Installing package...
Downloading...
Resolving dependencies...
Writing lock file
succeeded in 1500ms
mcp: jira/get_issue started
mcp: jira/get_issue completed
codex thinking about the solution
exec
/usr/bin/zsh -lc "php artisan test" in /home/user/project
PHPUnit 10.5
.....
succeeded in 850ms"""

# Longer output block (> 5 lines) to verify collapse happens
SAMPLE_LOG_LONG_OUTPUT = """\
exec
/usr/bin/zsh -lc "composer install" in /home/user/project
Loading composer repositories
Updating dependencies
Lock file operations: 5 installs
  - Installing psr/log (3.0.0)
  - Installing monolog/monolog (3.5.0)
  - Installing symfony/console (6.4.0)
  - Installing laravel/framework (10.0.0)
  - Installing phpunit/phpunit (10.5.0)
Generating autoload files
succeeded in 3200ms"""


def _run_pipeline(log_text: str, config: Config | None = None) -> list[str]:
    """Run sample log through the full pipeline, collecting output strings.

    Splits sample log into lines, runs each through:
    classify() → grouper.feed() → processing events → formatter methods

    Returns a list of all formatted output strings produced.
    """
    if config is None:
        config = Config(log_file="/tmp/test.log", no_color=True)

    formatter = Formatter(config, terminal_width=120)
    grouper = ActivityGrouper()
    output_lines: list[str] = []

    # Track accumulated lines per group for collapse decisions
    group_formatted_lines: list[str] = []
    current_group_raw_lines: list[str] = []

    lines = log_text.split("\n")
    for line in lines:
        classified = classify(line)
        events = grouper.feed(classified)

        for event in events:
            if event.event_type == OutputEventType.GROUP_START:
                # Start new group — print section header
                group_formatted_lines = []
                current_group_raw_lines = []
                header = formatter.format_section_header(event.group)
                output_lines.append(header)

            elif event.event_type == OutputEventType.GROUP_LINE:
                # Accumulate lines within the group
                formatted = formatter.format_output_line(event.line, indent=1)
                group_formatted_lines.append(formatted)
                current_group_raw_lines.append(event.line.raw)

            elif event.event_type == OutputEventType.GROUP_END:
                # Group ended — check collapse on accumulated lines
                if not config.no_collapse:
                    collapse_result = should_collapse(
                        current_group_raw_lines, config
                    )
                    if collapse_result.collapsed:
                        # Print preview lines (first 2)
                        for preview_line in group_formatted_lines[:2]:
                            output_lines.append(preview_line)
                        # Print collapse summary
                        summary = formatter.format_collapse_summary(collapse_result)
                        output_lines.append(summary)
                    else:
                        for accumulated_line in group_formatted_lines:
                            output_lines.append(accumulated_line)
                else:
                    for accumulated_line in group_formatted_lines:
                        output_lines.append(accumulated_line)

                # Print group end line
                if event.group:
                    end_line = formatter.format_group_end(event.group)
                    output_lines.append(end_line)

                # Reset group state
                group_formatted_lines = []
                current_group_raw_lines = []

            elif event.event_type == OutputEventType.STANDALONE:
                formatted = formatter.format_output_line(event.line, indent=0)
                output_lines.append(formatted)

    # Flush any remaining open group
    flush_events = grouper.flush()
    for event in flush_events:
        if event.event_type == OutputEventType.GROUP_END:
            if not config.no_collapse:
                collapse_result = should_collapse(
                    current_group_raw_lines, config
                )
                if collapse_result.collapsed:
                    for preview_line in group_formatted_lines[:2]:
                        output_lines.append(preview_line)
                    summary = formatter.format_collapse_summary(collapse_result)
                    output_lines.append(summary)
                else:
                    for accumulated_line in group_formatted_lines:
                        output_lines.append(accumulated_line)
            else:
                for accumulated_line in group_formatted_lines:
                    output_lines.append(accumulated_line)

            if event.group:
                end_line = formatter.format_group_end(event.group)
                output_lines.append(end_line)

    return output_lines


class TestIntegrationBasicPipeline:
    """Integration tests for the full pipeline with sample log content."""

    def test_no_exceptions_during_processing(self):
        """The full pipeline processes sample log without crashing."""
        output = _run_pipeline(SAMPLE_LOG)
        assert len(output) > 0

    def test_section_headers_produced_for_exec(self):
        """Section headers are produced when exec commands start."""
        output = _run_pipeline(SAMPLE_LOG)
        # The sample has 2 exec blocks, should produce headers with 🔧 icon
        headers_with_exec_icon = [
            line for line in output if "🔧" in line
        ]
        assert len(headers_with_exec_icon) >= 2, (
            f"Expected at least 2 exec headers, got {len(headers_with_exec_icon)}"
        )

    def test_section_headers_produced_for_mcp(self):
        """Section headers are produced when MCP calls start."""
        output = _run_pipeline(SAMPLE_LOG)
        # The sample has MCP calls, should produce header with 🔌 icon
        headers_with_mcp_icon = [
            line for line in output if "🔌" in line
        ]
        assert len(headers_with_mcp_icon) >= 1, (
            f"Expected at least 1 MCP header, got {len(headers_with_mcp_icon)}"
        )

    def test_output_lines_grouped_correctly(self):
        """Output lines within a group are accumulated and formatted."""
        output = _run_pipeline(SAMPLE_LOG)
        joined = "\n".join(output)
        # The first exec group has output lines: Installing, Downloading, etc.
        # These should appear in the output (they are <= 5 so not collapsed)
        assert "Installing package..." in joined
        assert "Downloading..." in joined
        assert "Resolving dependencies..." in joined
        assert "Writing lock file" in joined

    def test_short_output_not_collapsed(self):
        """Output blocks with <= 5 lines are NOT collapsed."""
        output = _run_pipeline(SAMPLE_LOG)
        joined = "\n".join(output)
        # The first exec has 4 output lines — should NOT be collapsed
        assert "lines collapsed" not in joined

    def test_group_end_shows_status_icons(self):
        """Group end lines show success/failure status icons."""
        output = _run_pipeline(SAMPLE_LOG)
        # Both exec commands succeed, so we should see ✅ icons
        success_icons = [line for line in output if "✅" in line]
        assert len(success_icons) >= 2, (
            f"Expected at least 2 success end lines, got {len(success_icons)}"
        )

    def test_ai_response_classified_correctly(self):
        """AI response lines get classified and formatted with robot icon."""
        output = _run_pipeline(SAMPLE_LOG)
        joined = "\n".join(output)
        # "codex thinking about the solution" is an AI_RESPONSE line
        assert "🤖" in joined, "AI response line should contain 🤖 icon"

    def test_timestamps_in_headers(self):
        """Section headers contain HH:MM:SS timestamps."""
        output = _run_pipeline(SAMPLE_LOG)
        timestamp_pattern = re.compile(r"\d{2}:\d{2}:\d{2}")
        headers_with_timestamps = [
            line for line in output if timestamp_pattern.search(line)
        ]
        # At least the exec and MCP headers should have timestamps
        assert len(headers_with_timestamps) >= 3

    def test_box_drawing_characters_in_output(self):
        """Unicode box-drawing characters are used in the output."""
        output = _run_pipeline(SAMPLE_LOG)
        joined = "\n".join(output)
        # Box-drawing range: U+2500–U+257F
        box_drawing_pattern = re.compile(r"[\u2500-\u257F]")
        assert box_drawing_pattern.search(joined), (
            "Expected Unicode box-drawing characters in output"
        )

    def test_tree_line_characters_in_group_output(self):
        """Output lines within groups use tree-line characters (│ or └)."""
        output = _run_pipeline(SAMPLE_LOG)
        tree_chars = {"│", "└"}
        lines_with_tree = [
            line for line in output
            if any(c in line for c in tree_chars)
        ]
        assert len(lines_with_tree) > 0, (
            "Expected tree-line characters in grouped output lines"
        )


class TestIntegrationCollapseLogic:
    """Integration tests for collapse behavior with longer output."""

    def test_long_output_block_is_collapsed(self):
        """Output blocks with > 5 lines are collapsed."""
        output = _run_pipeline(SAMPLE_LOG_LONG_OUTPUT)
        joined = "\n".join(output)
        # The exec has 9 output lines, should be collapsed
        assert "collapsed" in joined.lower() or "..." in joined, (
            "Expected collapse summary for long output block"
        )

    def test_collapse_shows_preview_lines(self):
        """Collapsed blocks show the first 2 preview lines before summary."""
        output = _run_pipeline(SAMPLE_LOG_LONG_OUTPUT)
        joined = "\n".join(output)
        # The command line and first output line appear as preview
        # (EXEC_COMMAND is the first group_line, then output lines follow)
        assert "composer install" in joined
        assert "Loading composer repositories" in joined

    def test_collapse_hides_middle_lines(self):
        """Collapsed blocks hide the middle lines."""
        output = _run_pipeline(SAMPLE_LOG_LONG_OUTPUT)
        joined = "\n".join(output)
        # Lines in the middle should be hidden (collapsed)
        # "Installing symfony/console" should not appear
        assert "symfony/console" not in joined

    def test_no_collapse_config_shows_all_lines(self):
        """With no_collapse=True, all lines are shown."""
        config = Config(log_file="/tmp/test.log", no_color=True, no_collapse=True)
        output = _run_pipeline(SAMPLE_LOG_LONG_OUTPUT, config=config)
        joined = "\n".join(output)
        # All lines should be visible
        assert "Loading composer repositories" in joined
        assert "symfony/console" in joined
        assert "Generating autoload files" in joined
        # No collapse summary
        assert "collapsed" not in joined.lower()


class TestIntegrationNoExceptions:
    """Verify no exceptions occur with various edge cases."""

    def test_empty_log(self):
        """Empty log content produces no output without crashing."""
        output = _run_pipeline("")
        # May produce standalone empty lines but should not crash
        assert isinstance(output, list)

    def test_only_exec_start_no_end(self):
        """An exec start without end is handled gracefully via flush."""
        log = "exec\n/usr/bin/zsh -lc \"ls\" in /home/user/project\nsome output"
        output = _run_pipeline(log)
        assert len(output) > 0
        # Should have a header at minimum
        assert any("🔧" in line for line in output)

    def test_multiple_mcp_calls_in_sequence(self):
        """Multiple MCP calls produce separate groups."""
        log = (
            "mcp: jira/get_issue started\n"
            "mcp: jira/get_issue completed\n"
            "mcp: bitbucket/create_pr started\n"
            "mcp: bitbucket/create_pr completed"
        )
        output = _run_pipeline(log)
        mcp_headers = [line for line in output if "🔌" in line]
        # Each MCP call starts a new group
        assert len(mcp_headers) >= 2

    def test_mixed_content_no_crash(self):
        """Mixed content types don't cause exceptions."""
        log = (
            "exec\n"
            "/usr/bin/zsh -lc \"grep -r foo\" in /project\n"
            "src/app.php:42:  $foo = bar;\n"
            "src/util.php:10: function foo()\n"
            "succeeded in 200ms\n"
            "codex analyzing results\n"
            "```php\n"
            "$x = 1;\n"
            "```\n"
        )
        output = _run_pipeline(log)
        assert len(output) > 0
