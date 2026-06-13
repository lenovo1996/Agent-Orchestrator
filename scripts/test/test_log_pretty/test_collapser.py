"""Property-based tests for log_pretty.collapser module.

Tests Property 7 (smart collapse threshold), Property 8 (search summary),
Property 9 (JSON summary), Property 15 (error blocks never collapsed),
and Property 17 (no-collapse flag) using Hypothesis strategies.
"""

import json

from hypothesis import given, settings
from hypothesis import strategies as st

from log_pretty.cli import Config
from log_pretty.collapser import CollapseResult, should_collapse, summarize_json, summarize_search_results


# ---------------------------------------------------------------------------
# Custom strategies
# ---------------------------------------------------------------------------


@st.composite
def st_output_block(draw, min_lines=1, max_lines=50):
    """Generate homogeneous output blocks (plain text lines without error/exception keywords).

    These are safe for collapse testing — they contain no error/exception keywords
    that would trigger Property 15 protection.
    """
    # Safe words that don't contain "error" or "exception" substrings
    safe_words = [
        "ok", "done", "info", "note", "step", "line", "data", "file",
        "path", "test", "pass", "load", "save", "read", "copy", "move",
        "run", "log", "set", "add", "put", "get", "has", "was", "can",
        "did", "may", "new", "old", "all", "any", "out", "now", "top",
        "end", "let", "try", "use", "big", "yes", "low", "two", "see",
        "few", "way", "its", "own", "how", "too", "far", "ask", "yet",
        "processing", "building", "compiling", "starting", "loading",
        "writing", "updating", "checking", "running", "installing",
    ]
    num_lines = draw(st.integers(min_value=min_lines, max_value=max_lines))
    lines = []
    for _ in range(num_lines):
        num_words = draw(st.integers(min_value=2, max_value=8))
        words = draw(st.lists(st.sampled_from(safe_words), min_size=num_words, max_size=num_words))
        lines.append(" ".join(words))
    return lines


@st.composite
def st_search_results(draw):
    """Generate search output blocks in path:line_number:content format.

    Generates realistic search results with varying file paths and line numbers.
    """
    num_results = draw(st.integers(min_value=1, max_value=20))

    # Generate some file paths to choose from
    num_files = draw(st.integers(min_value=1, max_value=min(num_results, 8)))
    file_paths = []
    for _ in range(num_files):
        depth = draw(st.integers(min_value=1, max_value=4))
        components = []
        for _ in range(depth):
            component = draw(st.from_regex(r"[a-z][a-z0-9_]{1,10}", fullmatch=True))
            components.append(component)
        ext = draw(st.sampled_from([".py", ".js", ".ts", ".php", ".rb", ".go"]))
        filename = draw(st.from_regex(r"[a-z][a-z0-9_]{1,10}", fullmatch=True))
        components[-1] = filename + ext
        file_paths.append("/".join(components))

    lines = []
    for _ in range(num_results):
        filepath = draw(st.sampled_from(file_paths))
        line_num = draw(st.integers(min_value=1, max_value=9999))
        content = draw(st.from_regex(r"[a-zA-Z_ ]{3,30}", fullmatch=True))
        lines.append(f"{filepath}:{line_num}:{content}")

    return lines


@st.composite
def st_json_object(draw):
    """Generate random JSON object strings with varying top-level keys.

    Returns a valid JSON string representation of a dict.
    """
    num_keys = draw(st.integers(min_value=1, max_value=10))
    obj = {}
    for _ in range(num_keys):
        key = draw(st.from_regex(r"[a-zA-Z][a-zA-Z0-9_]{0,15}", fullmatch=True))
        # Generate various value types
        value = draw(
            st.one_of(
                st.integers(min_value=-1000, max_value=1000),
                st.text(
                    alphabet=st.characters(whitelist_categories=("L", "N", "Zs")),
                    min_size=0,
                    max_size=20,
                ),
                st.booleans(),
                st.none(),
                st.lists(st.integers(min_value=0, max_value=100), min_size=0, max_size=5),
            )
        )
        obj[key] = value

    return json.dumps(obj)


@st.composite
def st_error_block(draw):
    """Generate output blocks that contain error/exception keywords.

    At least one line must contain 'error' or 'exception' (case-insensitive).
    """
    num_lines = draw(st.integers(min_value=1, max_value=20))
    lines = []

    # Generate some normal lines
    for _ in range(num_lines - 1):
        line = draw(
            st.from_regex(r"[A-Z][a-z]{2,8}( [a-z]{2,8}){0,3} done", fullmatch=True)
        )
        lines.append(line)

    # Insert at least one error/exception line at a random position
    error_keyword = draw(
        st.sampled_from([
            "Error: something went wrong",
            "RuntimeError: invalid state",
            "ValueError: bad input",
            "exception occurred in module",
            "Traceback (most recent call last): Exception",
            "FATAL ERROR: process crashed",
            "Unhandled exception in thread",
            "TypeError: expected string",
            "NullPointerException at line 42",
            "error: compilation failed",
        ])
    )
    insert_pos = draw(st.integers(min_value=0, max_value=len(lines)))
    lines.insert(insert_pos, error_keyword)

    return lines


# ---------------------------------------------------------------------------
# Property 7: Smart collapse threshold and preview
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 7: smart collapse threshold
@given(lines=st_output_block(min_lines=6, max_lines=50))
@settings(max_examples=100)
def test_should_collapse_more_than_5_lines_returns_collapsed(lines):
    """For any list of more than 5 homogeneous output lines,
    should_collapse (with default config) must return collapsed=True,
    exactly 2 preview lines, and a summary string containing the hidden
    line count as a number.

    Validates: Requirements 4.1, 4.2
    """
    config = Config(log_file="/tmp/test.log")
    result = should_collapse(lines, config)

    assert result.collapsed is True, (
        f"Expected collapsed=True for {len(lines)} lines, got {result.collapsed}"
    )
    assert len(result.preview_lines) == 2, (
        f"Expected exactly 2 preview lines, got {len(result.preview_lines)}"
    )
    # The hidden count should be total - 2 (the preview lines)
    expected_hidden = len(lines) - 2
    assert result.hidden_count == expected_hidden, (
        f"Expected hidden_count={expected_hidden}, got {result.hidden_count}"
    )
    # Summary must contain the hidden line count as a number
    assert str(expected_hidden) in result.summary, (
        f"Summary '{result.summary}' does not contain hidden count '{expected_hidden}'"
    )


# Feature: log-pretty-rebuild, Property 7: smart collapse threshold
@given(lines=st_output_block(min_lines=1, max_lines=5))
@settings(max_examples=100)
def test_should_collapse_5_or_fewer_lines_not_collapsed(lines):
    """For any list of 5 or fewer homogeneous output lines,
    should_collapse must return collapsed=False."""
    config = Config(log_file="/tmp/test.log")
    result = should_collapse(lines, config)

    assert result.collapsed is False, (
        f"Expected collapsed=False for {len(lines)} lines, got {result.collapsed}"
    )


# ---------------------------------------------------------------------------
# Property 8: Search results summary completeness
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 8: search summary
@given(lines=st_search_results())
@settings(max_examples=100)
def test_summarize_search_results_contains_match_count(lines):
    """For any block of search result lines (format path:line:content),
    summarize_search_results must return a string containing the total
    match count and at most 3 unique file paths from the input.

    Validates: Requirements 4.3
    """
    result = summarize_search_results(lines)

    # Count matches (lines matching path:line:content pattern)
    import re
    search_pattern = re.compile(r"^([^\s:]+):(\d+):(.*)$")
    match_count = 0
    unique_files = []
    for line in lines:
        m = search_pattern.match(line.strip())
        if m:
            match_count += 1
            filepath = m.group(1)
            if filepath not in unique_files:
                unique_files.append(filepath)

    # Summary must contain total match count
    assert str(match_count) in result, (
        f"Summary '{result}' does not contain match count '{match_count}'"
    )

    # Summary must contain at most 3 unique file paths
    files_in_summary = [f for f in unique_files if f in result]
    assert len(files_in_summary) <= 3, (
        f"Summary contains {len(files_in_summary)} file paths, expected at most 3. "
        f"Summary: '{result}'"
    )

    # At least some file paths should be present if there are matches
    if match_count > 0:
        expected_display_files = unique_files[:3]
        for f in expected_display_files:
            assert f in result, (
                f"Expected file path '{f}' to be in summary '{result}'"
            )


# ---------------------------------------------------------------------------
# Property 9: JSON summary shows top-level keys
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 9: JSON summary
@given(json_str=st_json_object())
@settings(max_examples=100)
def test_summarize_json_contains_all_top_level_keys(json_str):
    """For any valid JSON object string, summarize_json must return a
    string that contains all top-level key names from that object.

    Validates: Requirements 4.4
    """
    # Parse the JSON to get expected keys
    obj = json.loads(json_str)
    expected_keys = list(obj.keys())

    # summarize_json expects a list of lines
    lines = json_str.split("\n")
    result = summarize_json(lines)

    # All top-level keys must appear in the summary
    for key in expected_keys:
        assert key in result, (
            f"Key '{key}' not found in summary '{result}'. "
            f"JSON had keys: {expected_keys}"
        )


# ---------------------------------------------------------------------------
# Property 15: Error blocks are never collapsed
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 15: error blocks never collapsed
@given(lines=st_error_block())
@settings(max_examples=100)
def test_should_collapse_error_blocks_never_collapsed(lines):
    """For any output block containing error or exception keywords,
    should_collapse must return collapsed=False.

    Validates: Requirements 7.3
    """
    config = Config(log_file="/tmp/test.log")
    result = should_collapse(lines, config)

    assert result.collapsed is False, (
        f"Expected collapsed=False for error block, got collapsed=True. "
        f"Lines: {lines[:3]}..."
    )


# ---------------------------------------------------------------------------
# Property 17: No-collapse flag disables all collapsing
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 17: no-collapse flag
@given(lines=st_output_block(min_lines=1, max_lines=50))
@settings(max_examples=100)
def test_should_collapse_no_collapse_flag_disables_all(lines):
    """For any list of output lines (regardless of length or type),
    when config.no_collapse=True, should_collapse must return collapsed=False.

    Validates: Requirements 10.2
    """
    config = Config(log_file="/tmp/test.log", no_collapse=True)
    result = should_collapse(lines, config)

    assert result.collapsed is False, (
        f"Expected collapsed=False with no_collapse=True for {len(lines)} lines, "
        f"got collapsed=True"
    )


# Feature: log-pretty-rebuild, Property 17: no-collapse flag
@given(lines=st_output_block(min_lines=6, max_lines=50))
@settings(max_examples=100)
def test_should_collapse_no_collapse_flag_overrides_threshold(lines):
    """Even for long blocks that would normally be collapsed,
    no_collapse=True must prevent collapsing."""
    config = Config(log_file="/tmp/test.log", no_collapse=True)
    result = should_collapse(lines, config)

    assert result.collapsed is False, (
        f"Expected collapsed=False with no_collapse=True even for {len(lines)} lines "
        f"(above threshold), got collapsed=True"
    )
