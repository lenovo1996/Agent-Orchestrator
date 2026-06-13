"""Line Classifier for log_pretty.

Provides LineType enum for categorizing log lines and
ClassifiedLine dataclass for structured classification results.
"""

import re
from dataclasses import dataclass, field
from enum import Enum


class LineType(Enum):
    """Categories of log lines recognized by the classifier."""

    EXEC_START = "exec_start"
    EXEC_COMMAND = "exec_command"
    EXEC_SUCCEEDED = "exec_succeeded"
    EXEC_FAILED = "exec_failed"
    MCP_CALL = "mcp_call"
    FILE_READ = "file_read"
    SEARCH_RESULT = "search_result"
    AI_RESPONSE = "ai_response"
    WARNING = "warning"
    ERROR = "error"
    CODE_FENCE = "code_fence"
    OUTPUT = "output"
    EMPTY = "empty"


@dataclass
class ClassifiedLine:
    """A log line classified with its type and extracted metadata.

    Attributes:
        line_type: The category of this log line.
        raw: The original line text.
        metadata: Extracted info (command, path, tool_name, etc.)
    """

    line_type: LineType
    raw: str
    metadata: dict = field(default_factory=dict)


# Pre-compiled regex patterns for performance
_RE_EXEC_SUCCEEDED = re.compile(r"succeeded in\s*(?:(\d+)\s*ms)?")
_RE_EXEC_FAILED = re.compile(r"^\s*(Command\s+)?failed", re.IGNORECASE)
_RE_MCP_CALL = re.compile(r"^mcp:\s*(\S+)\s+(.*)")
_RE_FILE_READ = re.compile(
    r"(sed|cat|head|tail).*?(['\"])(.+?\.(?:md|php|json|txt))\2"
)
_RE_SEARCH_RESULT = re.compile(r"^([^\s:]+):(\d+):(.*)$")
_RE_AI_RESPONSE = re.compile(r"^(codex|assistant)\b")
_RE_WARNING = re.compile(r"(?:warning|warn)", re.IGNORECASE)
_RE_ERROR = re.compile(r"(?:error|exception)", re.IGNORECASE)
_RE_CODE_FENCE = re.compile(r"^\s*```")
_RE_EXEC_COMMAND = re.compile(r"^(/usr/bin/\S+|composer\s|php\s)")
_RE_EXEC_COMMAND_WORKDIR = re.compile(r'^(.*?)\s+in\s+("?)(.+?)\2\s*$')


def classify(line: str) -> ClassifiedLine:
    """Classify a raw log line into a typed structure."""
    # EMPTY: empty or whitespace-only line
    if not line.strip():
        return ClassifiedLine(line_type=LineType.EMPTY, raw=line, metadata={})

    stripped = line.strip()

    # EXEC_START: exact match "exec"
    if stripped == "exec":
        return ClassifiedLine(line_type=LineType.EXEC_START, raw=line, metadata={})

    # EXEC_SUCCEEDED: contains "succeeded in" with optional duration
    m = _RE_EXEC_SUCCEEDED.search(line)
    if m:
        duration_ms = int(m.group(1)) if m.group(1) else None
        return ClassifiedLine(
            line_type=LineType.EXEC_SUCCEEDED,
            raw=line,
            metadata={"duration_ms": duration_ms},
        )

    # EXEC_FAILED: starts with "failed" or "Command failed"
    if _RE_EXEC_FAILED.match(line):
        return ClassifiedLine(line_type=LineType.EXEC_FAILED, raw=line, metadata={})

    # EXEC_COMMAND: starts with /usr/bin/, composer, or php
    if _RE_EXEC_COMMAND.match(stripped):
        command = stripped
        workdir = None
        # Try to extract workdir from " in /path" suffix
        wm = _RE_EXEC_COMMAND_WORKDIR.match(stripped)
        if wm:
            command = wm.group(1)
            workdir = wm.group(3)
        return ClassifiedLine(
            line_type=LineType.EXEC_COMMAND,
            raw=line,
            metadata={"command": command, "workdir": workdir},
        )

    # MCP_CALL: starts with "mcp:"
    m = _RE_MCP_CALL.match(stripped)
    if m:
        tool_name = m.group(1)
        status = m.group(2).strip()
        return ClassifiedLine(
            line_type=LineType.MCP_CALL,
            raw=line,
            metadata={"tool_name": tool_name, "status": status},
        )

    # FILE_READ: sed/cat/head/tail reading specific file types
    m = _RE_FILE_READ.search(line)
    if m:
        file_path = m.group(3)
        return ClassifiedLine(
            line_type=LineType.FILE_READ,
            raw=line,
            metadata={"path": file_path},
        )

    # SEARCH_RESULT: path:line_no:content pattern (grep/rg output)
    m = _RE_SEARCH_RESULT.match(stripped)
    if m:
        return ClassifiedLine(
            line_type=LineType.SEARCH_RESULT,
            raw=line,
            metadata={
                "path": m.group(1),
                "line_no": m.group(2),
                "content": m.group(3),
            },
        )

    # AI_RESPONSE: starts with "codex" or "assistant"
    m = _RE_AI_RESPONSE.match(stripped)
    if m:
        return ClassifiedLine(
            line_type=LineType.AI_RESPONSE,
            raw=line,
            metadata={"source": m.group(1)},
        )

    # CODE_FENCE: line starts with ```
    if _RE_CODE_FENCE.match(line):
        return ClassifiedLine(line_type=LineType.CODE_FENCE, raw=line, metadata={})

    # WARNING: contains "warning" or "warn" (case insensitive)
    # Check before ERROR because a line could have both — but prioritize warning
    if _RE_WARNING.search(line):
        return ClassifiedLine(line_type=LineType.WARNING, raw=line, metadata={})

    # ERROR: contains "error" or "exception" (case insensitive)
    if _RE_ERROR.search(line):
        return ClassifiedLine(line_type=LineType.ERROR, raw=line, metadata={})

    # OUTPUT: indented lines, JSON objects/arrays starting with { or [
    if line.startswith("   ") or stripped.startswith("{") or stripped.startswith("["):
        return ClassifiedLine(line_type=LineType.OUTPUT, raw=line, metadata={})

    # Default: OUTPUT for anything else that doesn't match
    return ClassifiedLine(line_type=LineType.OUTPUT, raw=line, metadata={})
