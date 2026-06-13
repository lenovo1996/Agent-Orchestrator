"""Property-based tests for log_pretty.classifier module.

Tests Property 1 (classifier part) and Property 14 (classifier part)
using Hypothesis strategies.
"""

from hypothesis import given, settings
from hypothesis import strategies as st

from log_pretty.classifier import ClassifiedLine, LineType, classify


# ---------------------------------------------------------------------------
# Custom strategies
# ---------------------------------------------------------------------------


@st.composite
def st_exec_line(draw):
    """Generate the exact 'exec' line that triggers EXEC_START classification."""
    # The classifier matches stripped == "exec", so generate with optional whitespace
    leading = draw(st.sampled_from(["", " ", "  "]))
    trailing = draw(st.sampled_from(["", " ", "  "]))
    return f"{leading}exec{trailing}"


@st.composite
def st_mcp_line(draw):
    """Generate random MCP tool call strings like 'mcp: toolname/action started|completed'."""
    tool_name = draw(
        st.from_regex(r"[a-z][a-z0-9_]{1,20}(/[a-z][a-z0-9_]{1,15})?", fullmatch=True)
    )
    status = draw(st.sampled_from(["started", "completed", "failed", "in_progress"]))
    # Optional extra text after status
    extra = draw(st.sampled_from(["", " some details", " (timeout=30s)"]))
    return f"mcp: {tool_name} {status}{extra}"


@st.composite
def st_ai_response_line(draw):
    """Generate lines starting with 'codex' or 'assistant' followed by text."""
    prefix = draw(st.sampled_from(["codex", "assistant"]))
    # Text after prefix: could be space + content, colon + content, etc.
    separator = draw(st.sampled_from([" ", ": ", " > "]))
    content = draw(st.text(min_size=1, max_size=80, alphabet=st.characters(
        whitelist_categories=("L", "N", "P", "Z"),
        blacklist_characters="\x00\n\r",
    )))
    return f"{prefix}{separator}{content}"


# ---------------------------------------------------------------------------
# Property 1 (classifier part): Activity start produces distinct headers
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 1: Activity start produces distinct section headers
@given(line=st_exec_line())
@settings(max_examples=100)
def test_exec_start_classified_correctly(line):
    """Exec start lines must be classified as EXEC_START."""
    result = classify(line)
    assert isinstance(result, ClassifiedLine)
    assert result.line_type == LineType.EXEC_START


# Feature: log-pretty-rebuild, Property 1: Activity start produces distinct section headers
@given(line=st_mcp_line())
@settings(max_examples=100)
def test_mcp_call_classified_correctly(line):
    """MCP tool call lines must be classified as MCP_CALL."""
    result = classify(line)
    assert isinstance(result, ClassifiedLine)
    assert result.line_type == LineType.MCP_CALL
    # Metadata should contain tool_name and status
    assert "tool_name" in result.metadata
    assert "status" in result.metadata


# Feature: log-pretty-rebuild, Property 1: Activity start produces distinct section headers
@given(exec_line=st_exec_line(), mcp_line=st_mcp_line())
@settings(max_examples=100)
def test_exec_and_mcp_classified_distinctly(exec_line, mcp_line):
    """Exec and MCP lines must be classified into different types."""
    exec_result = classify(exec_line)
    mcp_result = classify(mcp_line)
    assert exec_result.line_type != mcp_result.line_type
    assert exec_result.line_type == LineType.EXEC_START
    assert mcp_result.line_type == LineType.MCP_CALL


# ---------------------------------------------------------------------------
# Property 14 (classifier part): AI response detection
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 14: AI response lines display robot icon
@given(line=st_ai_response_line())
@settings(max_examples=100)
def test_ai_response_classified_correctly(line):
    """Lines starting with 'codex' or 'assistant' must be classified as AI_RESPONSE."""
    result = classify(line)
    assert isinstance(result, ClassifiedLine)
    assert result.line_type == LineType.AI_RESPONSE
    # Metadata should contain source
    assert "source" in result.metadata
    assert result.metadata["source"] in ("codex", "assistant")
