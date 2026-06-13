"""Property-based tests for log_pretty.formatter module.

Tests Property 2 (timestamp in headers), Property 3 (box-drawing chars),
Property 4 (indentation with tree-lines), Property 5 (group end shows icon+duration),
Property 10 (no-color eliminates ANSI), Property 11 (line truncation),
Property 16 (startup header fields), and Property 18 (verbose mode)
using Hypothesis strategies.
"""

import re
import time

from hypothesis import given, settings
from hypothesis import strategies as st

from log_pretty.formatter import Formatter, _strip_ansi
from log_pretty.grouper import ActivityGroup
from log_pretty.classifier import ClassifiedLine, LineType
from log_pretty.collapser import CollapseResult
from log_pretty.cli import Config


# ---------------------------------------------------------------------------
# Custom strategies
# ---------------------------------------------------------------------------


@st.composite
def st_activity_group(draw):
    """Generate ActivityGroup instances with random group_type, command, start_time, status."""
    group_type = draw(st.sampled_from(["exec", "mcp"]))
    command = draw(
        st.text(
            alphabet=st.characters(whitelist_categories=("L", "N", "Zs", "P")),
            min_size=1,
            max_size=60,
        )
    )
    # Start time: sometime in the last hour
    start_time = time.time() - draw(st.floats(min_value=0.01, max_value=3600.0))
    status = draw(st.sampled_from(["succeeded", "failed", None]))

    group = ActivityGroup(
        group_type=group_type,
        command=command,
        start_time=start_time,
        status=status,
    )
    return group


@st.composite
def st_completed_activity_group(draw):
    """Generate completed ActivityGroup instances (status is succeeded or failed)."""
    group_type = draw(st.sampled_from(["exec", "mcp"]))
    command = draw(
        st.text(
            alphabet=st.characters(whitelist_categories=("L", "N", "Zs", "P")),
            min_size=1,
            max_size=60,
        )
    )
    # Start time: sometime in the past (to produce a positive duration)
    start_time = time.time() - draw(st.floats(min_value=0.01, max_value=300.0))
    status = draw(st.sampled_from(["succeeded", "failed"]))

    group = ActivityGroup(
        group_type=group_type,
        command=command,
        start_time=start_time,
        status=status,
    )
    return group


@st.composite
def st_classified_line(draw):
    """Generate ClassifiedLine instances with various line types."""
    line_type = draw(
        st.sampled_from([
            LineType.OUTPUT,
            LineType.FILE_READ,
            LineType.SEARCH_RESULT,
            LineType.AI_RESPONSE,
            LineType.WARNING,
            LineType.ERROR,
            LineType.CODE_FENCE,
        ])
    )
    raw = draw(
        st.text(
            alphabet=st.characters(whitelist_categories=("L", "N", "Zs", "P")),
            min_size=1,
            max_size=80,
        )
    )
    metadata = {}
    if line_type == LineType.FILE_READ:
        metadata["path"] = draw(
            st.text(
                alphabet=st.characters(whitelist_categories=("L", "N")),
                min_size=5,
                max_size=40,
            )
        )

    return ClassifiedLine(line_type=line_type, raw=raw, metadata=metadata)


@st.composite
def st_terminal_width(draw):
    """Generate random terminal widths (40-300)."""
    return draw(st.integers(min_value=40, max_value=300))


@st.composite
def st_text_field(draw):
    """Generate random text for flow_id, agent_step, log_file fields."""
    return draw(
        st.text(
            alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
            min_size=1,
            max_size=40,
        )
    )


# ---------------------------------------------------------------------------
# Helper constants
# ---------------------------------------------------------------------------

_RE_TIMESTAMP_HH_MM_SS = re.compile(r"\d{2}:\d{2}:\d{2}")
_RE_ISO_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
_RE_ANSI_ESCAPE = re.compile(r"\033\[")

# Unicode box-drawing characters range: U+2500–U+257F
_BOX_DRAWING_CHARS = set(chr(c) for c in range(0x2500, 0x2580))


def _contains_box_drawing(text: str) -> bool:
    """Check if text contains at least one Unicode box-drawing character."""
    return any(ch in _BOX_DRAWING_CHARS for ch in text)


# ---------------------------------------------------------------------------
# Property 2: Section headers contain HH:MM:SS timestamp
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 2: timestamp in headers
@given(group=st_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_section_header_contains_timestamp(group, width):
    """For any section header produced by the formatter, the output string
    must contain a substring matching regex \\d{2}:\\d{2}:\\d{2}.

    Validates: Requirements 1.4
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    header = formatter.format_section_header(group)

    assert _RE_TIMESTAMP_HH_MM_SS.search(_strip_ansi(header)), (
        f"Section header does not contain HH:MM:SS timestamp.\n"
        f"Header (stripped): {_strip_ansi(header)!r}"
    )


# ---------------------------------------------------------------------------
# Property 3: Headers use Unicode box-drawing characters
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 3: box-drawing chars
@given(group=st_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_section_header_contains_box_drawing(group, width):
    """For any section header produced by the formatter, output must contain
    at least one Unicode box-drawing character (U+2500–U+257F range).

    Validates: Requirements 1.3, 9.3
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    header = formatter.format_section_header(group)

    assert _contains_box_drawing(header), (
        f"Section header does not contain any box-drawing characters.\n"
        f"Header: {header!r}"
    )


# Feature: log-pretty-rebuild, Property 3: box-drawing chars
@given(
    flow_id=st_text_field(),
    agent_step=st_text_field(),
    log_file=st_text_field(),
    width=st_terminal_width(),
)
@settings(max_examples=100)
def test_startup_header_contains_box_drawing(flow_id, agent_step, log_file, width):
    """For any startup header produced by the formatter, output must contain
    at least one Unicode box-drawing character (U+2500–U+257F range).

    Validates: Requirements 1.3, 9.3
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    header = formatter.format_startup_header(flow_id, agent_step, log_file, jira_key=None)

    assert _contains_box_drawing(header), (
        f"Startup header does not contain any box-drawing characters.\n"
        f"Header: {header!r}"
    )


# ---------------------------------------------------------------------------
# Property 4: Output lines indented with tree-line characters
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 4: indentation with tree-lines
@given(
    group=st_activity_group(),
    line=st_classified_line(),
    indent=st.integers(min_value=0, max_value=5),
    width=st_terminal_width(),
)
@settings(max_examples=100)
def test_output_line_contains_tree_line_characters(group, line, indent, width):
    """For any activity group with output lines, each formatted output line
    must have greater indentation than the command header and must contain
    tree-line characters (│ or └).

    Validates: Requirements 2.1, 2.3
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    output = formatter.format_output_line(line, indent)
    stripped_output = _strip_ansi(output)

    # Must contain │ or └ tree-line characters
    assert "│" in stripped_output or "└" in stripped_output, (
        f"Output line does not contain tree-line characters (│ or └).\n"
        f"Output (stripped): {stripped_output!r}"
    )

    # Must have leading whitespace (indentation greater than zero)
    assert stripped_output[0] == " ", (
        f"Output line does not have indentation (leading space).\n"
        f"Output (stripped): {stripped_output!r}"
    )


# ---------------------------------------------------------------------------
# Property 5: Group end shows status icon and duration
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 5: group end shows icon+duration
@given(group=st_completed_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_group_end_contains_icon_and_duration(group, width):
    """For any completed activity group (with status "succeeded" or "failed"),
    the formatted group-end line must contain both a status icon (✅ or ❌)
    and the duration value.

    Validates: Requirements 2.2, 2.4, 3.3
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    end_line = formatter.format_group_end(group)
    stripped = _strip_ansi(end_line)

    # Must contain status icon
    has_success_icon = "✅" in stripped
    has_failure_icon = "❌" in stripped
    assert has_success_icon or has_failure_icon, (
        f"Group end does not contain status icon (✅ or ❌).\n"
        f"Status: {group.status}, End line: {stripped!r}"
    )

    # Correct icon for status
    if group.status == "succeeded":
        assert has_success_icon, (
            f"Succeeded group should show ✅ but got: {stripped!r}"
        )
    else:
        assert has_failure_icon, (
            f"Failed group should show ❌ but got: {stripped!r}"
        )

    # Must contain a duration value (ms or s or m format)
    duration_pattern = re.compile(r"\d+(\.\d+)?(ms|s|m)")
    assert duration_pattern.search(stripped), (
        f"Group end does not contain duration value.\n"
        f"End line: {stripped!r}"
    )


# ---------------------------------------------------------------------------
# Property 10: No-color mode eliminates ANSI escapes
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 10: no-color eliminates ANSI
@given(group=st_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_no_color_section_header_no_ansi(group, width):
    """For any log line formatted with no_color=True, the output string
    must NOT contain any ANSI escape sequence (no \\033[ substring).

    Validates: Requirements 5.3, 10.3
    """
    config = Config(log_file="/tmp/test.log", no_color=True)
    formatter = Formatter(config, terminal_width=width)

    header = formatter.format_section_header(group)
    assert "\033[" not in header, (
        f"Section header contains ANSI escape with no_color=True.\n"
        f"Header: {header!r}"
    )


# Feature: log-pretty-rebuild, Property 10: no-color eliminates ANSI
@given(line=st_classified_line(), indent=st.integers(min_value=0, max_value=5), width=st_terminal_width())
@settings(max_examples=100)
def test_no_color_output_line_no_ansi(line, indent, width):
    """For any output line formatted with no_color=True, the output string
    must NOT contain any ANSI escape sequence (no \\033[ substring).

    Validates: Requirements 5.3, 10.3
    """
    config = Config(log_file="/tmp/test.log", no_color=True)
    formatter = Formatter(config, terminal_width=width)

    output = formatter.format_output_line(line, indent)
    assert "\033[" not in output, (
        f"Output line contains ANSI escape with no_color=True.\n"
        f"Output: {output!r}"
    )


# Feature: log-pretty-rebuild, Property 10: no-color eliminates ANSI
@given(group=st_completed_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_no_color_group_end_no_ansi(group, width):
    """For any group end formatted with no_color=True, the output string
    must NOT contain any ANSI escape sequence (no \\033[ substring).

    Validates: Requirements 5.3, 10.3
    """
    config = Config(log_file="/tmp/test.log", no_color=True)
    formatter = Formatter(config, terminal_width=width)

    end_line = formatter.format_group_end(group)
    assert "\033[" not in end_line, (
        f"Group end contains ANSI escape with no_color=True.\n"
        f"End line: {end_line!r}"
    )


# ---------------------------------------------------------------------------
# Property 11: Line truncation respects terminal width
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 11: line truncation
@given(group=st_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_section_header_respects_terminal_width(group, width):
    """For any output line and any terminal width W, the visible length
    (excluding ANSI codes) must not exceed W characters.

    Validates: Requirements 5.4
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    header = formatter.format_section_header(group)
    visible_len = len(_strip_ansi(header))

    assert visible_len <= width, (
        f"Section header visible length ({visible_len}) exceeds "
        f"terminal width ({width}).\n"
        f"Header (stripped): {_strip_ansi(header)!r}"
    )


# Feature: log-pretty-rebuild, Property 11: line truncation
@given(line=st_classified_line(), indent=st.integers(min_value=0, max_value=5), width=st_terminal_width())
@settings(max_examples=100)
def test_output_line_respects_terminal_width(line, indent, width):
    """For any output line and any terminal width W, the visible length
    (excluding ANSI codes) must not exceed W characters.

    Validates: Requirements 5.4
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    output = formatter.format_output_line(line, indent)
    visible_len = len(_strip_ansi(output))

    assert visible_len <= width, (
        f"Output line visible length ({visible_len}) exceeds "
        f"terminal width ({width}).\n"
        f"Output (stripped): {_strip_ansi(output)!r}"
    )


# Feature: log-pretty-rebuild, Property 11: line truncation
@given(group=st_completed_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_group_end_respects_terminal_width(group, width):
    """For any group end and any terminal width W, the visible length
    (excluding ANSI codes) must not exceed W characters.

    Validates: Requirements 5.4
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    end_line = formatter.format_group_end(group)
    visible_len = len(_strip_ansi(end_line))

    assert visible_len <= width, (
        f"Group end visible length ({visible_len}) exceeds "
        f"terminal width ({width}).\n"
        f"End line (stripped): {_strip_ansi(end_line)!r}"
    )


# ---------------------------------------------------------------------------
# Property 16: Startup header contains all context fields
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 16: startup header fields
@given(
    flow_id=st_text_field(),
    agent_step=st_text_field(),
    log_file=st_text_field(),
    width=st_terminal_width(),
)
@settings(max_examples=100)
def test_startup_header_contains_all_fields(flow_id, agent_step, log_file, width):
    """For any combination of flow_id, agent_step, and log_file strings,
    the formatted startup header must contain all three values as substrings.

    Validates: Requirements 9.1
    """
    config = Config(log_file="/tmp/test.log")
    formatter = Formatter(config, terminal_width=width)

    header = formatter.format_startup_header(flow_id, agent_step, log_file, jira_key=None)

    assert flow_id in header, (
        f"Startup header does not contain flow_id '{flow_id}'.\n"
        f"Header: {header!r}"
    )
    assert agent_step in header, (
        f"Startup header does not contain agent_step '{agent_step}'.\n"
        f"Header: {header!r}"
    )
    assert log_file in header, (
        f"Startup header does not contain log_file '{log_file}'.\n"
        f"Header: {header!r}"
    )


# ---------------------------------------------------------------------------
# Property 18: Verbose mode shows full ISO timestamp
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 18: verbose mode
@given(group=st_activity_group(), width=st_terminal_width())
@settings(max_examples=100)
def test_verbose_section_header_full_iso_timestamp(group, width):
    """For any log line with verbose=True, section headers must contain
    full ISO timestamp (regex \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}),
    not just HH:MM:SS.

    Validates: Requirements 10.4
    """
    config = Config(log_file="/tmp/test.log", verbose=True)
    formatter = Formatter(config, terminal_width=width)

    header = formatter.format_section_header(group)
    stripped = _strip_ansi(header)

    assert _RE_ISO_TIMESTAMP.search(stripped), (
        f"Verbose section header does not contain full ISO timestamp "
        f"(YYYY-MM-DDTHH:MM:SS).\n"
        f"Header (stripped): {stripped!r}"
    )
