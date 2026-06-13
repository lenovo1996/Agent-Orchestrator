"""Smart Collapser for log_pretty.

Decides whether blocks of output should be collapsed, and provides
context-aware summaries for search results and JSON output.
"""

import json
import re
from dataclasses import dataclass, field

from .cli import Config


# Keywords that indicate error/exception content — never collapse these
# No word boundaries: must catch "RuntimeError", "ValueError", etc.
_ERROR_KEYWORDS = re.compile(r"(error|exception)", re.IGNORECASE)

# Pattern for search result lines: path:line_number:content
_RE_SEARCH_LINE = re.compile(r"^([^\s:]+):(\d+):(.*)$")


@dataclass
class CollapseResult:
    """Result of a collapse decision.

    Attributes:
        collapsed: Whether the content was collapsed.
        preview_lines: First lines shown as preview (up to 2).
        summary: Human-readable summary (e.g. "42 lines collapsed").
        hidden_count: Number of lines hidden from view.
    """

    collapsed: bool
    preview_lines: list[str] = field(default_factory=list)
    summary: str = ""
    hidden_count: int = 0


def should_collapse(lines: list[str], config: Config) -> CollapseResult:
    """Decide if a block of output should be collapsed.

    Rules (in order):
    1. If config.no_collapse is True → never collapse (Property 17)
    2. If lines contain error/exception keywords → never collapse (Property 15)
    3. If len(lines) > 5 → collapse with 2 preview lines + summary (Property 7)
    4. Otherwise → don't collapse

    For collapsed blocks, the summary is context-aware:
    - Search results → summarize_search_results
    - JSON content → summarize_json
    - Otherwise → generic "{N} lines collapsed"
    """
    # Property 17: no_collapse flag disables all collapsing
    if config.no_collapse:
        return CollapseResult(collapsed=False)

    # Property 15: error/exception blocks are never collapsed
    for line in lines:
        if _ERROR_KEYWORDS.search(line):
            return CollapseResult(collapsed=False)

    # Property 7: collapse when more than 5 lines
    if len(lines) > 5:
        preview = lines[:2]
        hidden_count = len(lines) - 2

        # Determine summary based on content type
        if _looks_like_search_results(lines):
            summary = summarize_search_results(lines)
        elif _looks_like_json(lines):
            summary = summarize_json(lines)
        else:
            summary = f"{hidden_count} lines collapsed"

        return CollapseResult(
            collapsed=True,
            preview_lines=preview,
            summary=summary,
            hidden_count=hidden_count,
        )

    # Not enough lines to collapse
    return CollapseResult(collapsed=False)


def summarize_search_results(lines: list[str]) -> str:
    """Extract match count and unique files from search output.

    For search result lines in format path:line:content, returns
    a summary like "5 matches in 3 files (foo.py, bar.js, baz.ts)".

    Property 8: Must return total match count and at most 3 unique file paths.
    """
    files: list[str] = []
    match_count = 0

    for line in lines:
        m = _RE_SEARCH_LINE.match(line.strip())
        if m:
            match_count += 1
            filepath = m.group(1)
            if filepath not in files:
                files.append(filepath)

    # Show at most 3 unique file paths
    display_files = files[:3]
    files_str = ", ".join(display_files)

    if match_count == 0:
        return "0 matches"

    return f"{match_count} matches in {len(files)} files ({files_str})"


def summarize_json(lines: list[str]) -> str:
    """Extract top-level keys from JSON output.

    Property 9: Must return a string that contains all top-level key names.
    Falls back to generic summary if JSON is not parseable.
    """
    text = "\n".join(lines)
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        # Fallback: generic summary
        return f"{len(lines)} lines of JSON"

    if isinstance(obj, dict):
        keys = list(obj.keys())
        if keys:
            keys_str = ", ".join(keys)
            return f"JSON object with keys: {keys_str}"
        return "JSON empty object"

    # For arrays or other types, give generic summary
    if isinstance(obj, list):
        return f"JSON array with {len(obj)} items"

    return f"{len(lines)} lines of JSON"


def _looks_like_search_results(lines: list[str]) -> bool:
    """Heuristic: if majority of lines match search result pattern."""
    if not lines:
        return False
    matches = sum(1 for line in lines if _RE_SEARCH_LINE.match(line.strip()))
    return matches > len(lines) / 2


def _looks_like_json(lines: list[str]) -> bool:
    """Heuristic: if the joined lines form a parseable JSON object."""
    if not lines:
        return False
    text = "\n".join(lines)
    stripped = text.strip()
    if not (stripped.startswith("{") or stripped.startswith("[")):
        return False
    try:
        json.loads(stripped)
        return True
    except (json.JSONDecodeError, ValueError):
        return False
