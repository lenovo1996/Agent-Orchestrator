"""Activity Grouper for log_pretty.

Groups consecutive log lines into logical activities (exec commands,
MCP tool calls) and emits OutputEvents for the formatter to render.
"""

import time
from dataclasses import dataclass, field
from enum import Enum

from log_pretty.classifier import ClassifiedLine, LineType


class OutputEventType(Enum):
    """Types of output events emitted by the grouper."""

    GROUP_START = "group_start"
    GROUP_LINE = "group_line"
    GROUP_END = "group_end"
    STANDALONE = "standalone"


@dataclass
class ActivityGroup:
    """A logical group of log lines representing a single activity.

    Attributes:
        group_type: The kind of activity ("exec" or "mcp").
        command: The command text or tool name.
        start_time: Unix timestamp when the group started.
        lines: Collected classified lines within this group.
        status: Final status ("succeeded", "failed", or None if in progress).
    """

    group_type: str  # "exec" | "mcp"
    command: str
    start_time: float
    lines: list[ClassifiedLine] = field(default_factory=list)
    status: str | None = None  # "succeeded" | "failed" | None (in progress)


@dataclass
class OutputEvent:
    """An event emitted by the grouper for the formatter to render.

    Attributes:
        event_type: The kind of output event.
        group: The associated ActivityGroup (for group_start/group_end).
        line: The classified line (for group_line/standalone).
        duration: Duration in seconds (for group_end events).
    """

    event_type: OutputEventType
    group: ActivityGroup | None = None
    line: ClassifiedLine | None = None
    duration: float | None = None


class ActivityGrouper:
    """Groups classified log lines into activity groups.

    Feed classified lines one at a time; the grouper tracks state
    and emits OutputEvents indicating when groups start, receive
    lines, and end.
    """

    def __init__(self) -> None:
        self.current_group: ActivityGroup | None = None

    def feed(self, classified: ClassifiedLine) -> list[OutputEvent]:
        """Feed a classified line and return output events.

        Logic:
        1. EXEC_START → start a new exec group (close previous if exists)
        2. MCP_CALL → start a new MCP group (close previous if exists)
        3. EXEC_SUCCEEDED/EXEC_FAILED → close current exec group with status
        4. If in a group → add line to current group, emit group_line
        5. If not in a group → emit standalone

        Args:
            classified: A ClassifiedLine from the classifier.

        Returns:
            A list of OutputEvent objects for the formatter.
        """
        events: list[OutputEvent] = []

        if classified.line_type == LineType.EXEC_START:
            # Close previous group if one is open
            if self.current_group is not None:
                events.extend(self._close_current_group())
            # Start a new exec group
            command = classified.metadata.get("command", "")
            self.current_group = ActivityGroup(
                group_type="exec",
                command=command,
                start_time=time.time(),
            )
            self.current_group.lines.append(classified)
            events.append(
                OutputEvent(
                    event_type=OutputEventType.GROUP_START,
                    group=self.current_group,
                    line=classified,
                )
            )
            return events

        if classified.line_type == LineType.MCP_CALL:
            # Close previous group if one is open
            if self.current_group is not None:
                events.extend(self._close_current_group())
            # Start a new MCP group
            tool_name = classified.metadata.get("tool_name", "")
            self.current_group = ActivityGroup(
                group_type="mcp",
                command=tool_name,
                start_time=time.time(),
            )
            self.current_group.lines.append(classified)
            events.append(
                OutputEvent(
                    event_type=OutputEventType.GROUP_START,
                    group=self.current_group,
                    line=classified,
                )
            )
            return events

        if classified.line_type == LineType.EXEC_SUCCEEDED:
            if self.current_group is not None:
                self.current_group.status = "succeeded"
                self.current_group.lines.append(classified)
                duration = time.time() - self.current_group.start_time
                events.append(
                    OutputEvent(
                        event_type=OutputEventType.GROUP_END,
                        group=self.current_group,
                        line=classified,
                        duration=duration,
                    )
                )
                self.current_group = None
            else:
                # No open group — emit as standalone
                events.append(
                    OutputEvent(
                        event_type=OutputEventType.STANDALONE,
                        line=classified,
                    )
                )
            return events

        if classified.line_type == LineType.EXEC_FAILED:
            if self.current_group is not None:
                self.current_group.status = "failed"
                self.current_group.lines.append(classified)
                duration = time.time() - self.current_group.start_time
                events.append(
                    OutputEvent(
                        event_type=OutputEventType.GROUP_END,
                        group=self.current_group,
                        line=classified,
                        duration=duration,
                    )
                )
                self.current_group = None
            else:
                # No open group — emit as standalone
                events.append(
                    OutputEvent(
                        event_type=OutputEventType.STANDALONE,
                        line=classified,
                    )
                )
            return events

        # For all other line types
        if self.current_group is not None:
            # Add to current group, emit group_line
            self.current_group.lines.append(classified)
            events.append(
                OutputEvent(
                    event_type=OutputEventType.GROUP_LINE,
                    group=self.current_group,
                    line=classified,
                )
            )
        else:
            # No active group — emit standalone
            events.append(
                OutputEvent(
                    event_type=OutputEventType.STANDALONE,
                    line=classified,
                )
            )

        return events

    def _close_current_group(self) -> list[OutputEvent]:
        """Close the current group without a terminal status.

        Used when a new group starts before the previous one
        received an explicit succeeded/failed terminator.

        Returns:
            A list containing the group_end event.
        """
        events: list[OutputEvent] = []
        if self.current_group is not None:
            duration = time.time() - self.current_group.start_time
            events.append(
                OutputEvent(
                    event_type=OutputEventType.GROUP_END,
                    group=self.current_group,
                    duration=duration,
                )
            )
            self.current_group = None
        return events

    def flush(self) -> list[OutputEvent]:
        """Flush any open group at end of input.

        Call this when no more lines will be fed to ensure the
        current group (if any) is properly closed.

        Returns:
            A list of OutputEvent objects (empty if no open group).
        """
        return self._close_current_group()
