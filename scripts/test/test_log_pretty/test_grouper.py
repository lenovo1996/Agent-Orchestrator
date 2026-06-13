"""Unit tests for log_pretty.grouper module."""

import time
from unittest.mock import patch

from log_pretty.classifier import ClassifiedLine, LineType
from log_pretty.grouper import (
    ActivityGroup,
    ActivityGrouper,
    OutputEvent,
    OutputEventType,
)


class TestActivityGroup:
    """Tests for ActivityGroup dataclass."""

    def test_create_exec_group(self):
        """ActivityGroup can be created with exec type."""
        group = ActivityGroup(
            group_type="exec",
            command="php artisan migrate",
            start_time=1000.0,
        )
        assert group.group_type == "exec"
        assert group.command == "php artisan migrate"
        assert group.start_time == 1000.0
        assert group.lines == []
        assert group.status is None

    def test_create_mcp_group(self):
        """ActivityGroup can be created with mcp type."""
        group = ActivityGroup(
            group_type="mcp",
            command="read_file",
            start_time=2000.0,
            status="succeeded",
        )
        assert group.group_type == "mcp"
        assert group.command == "read_file"
        assert group.status == "succeeded"

    def test_lines_default_empty(self):
        """Lines default to empty list."""
        group = ActivityGroup(group_type="exec", command="ls", start_time=0.0)
        assert group.lines == []


class TestOutputEvent:
    """Tests for OutputEvent dataclass."""

    def test_standalone_event(self):
        """OutputEvent can represent a standalone line."""
        line = ClassifiedLine(line_type=LineType.OUTPUT, raw="hello", metadata={})
        event = OutputEvent(event_type=OutputEventType.STANDALONE, line=line)
        assert event.event_type == OutputEventType.STANDALONE
        assert event.line == line
        assert event.group is None
        assert event.duration is None

    def test_group_end_event_with_duration(self):
        """OutputEvent can carry duration for group_end."""
        group = ActivityGroup(
            group_type="exec", command="test", start_time=0.0, status="succeeded"
        )
        event = OutputEvent(
            event_type=OutputEventType.GROUP_END, group=group, duration=5.2
        )
        assert event.duration == 5.2
        assert event.group.status == "succeeded"


class TestActivityGrouperFeed:
    """Tests for ActivityGrouper.feed() method."""

    def test_exec_start_creates_group(self):
        """EXEC_START line starts a new exec group."""
        grouper = ActivityGrouper()
        line = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})

        events = grouper.feed(line)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.GROUP_START
        assert events[0].group is not None
        assert events[0].group.group_type == "exec"
        assert grouper.current_group is not None

    def test_mcp_call_creates_group(self):
        """MCP_CALL line starts a new MCP group."""
        grouper = ActivityGrouper()
        line = ClassifiedLine(
            line_type=LineType.MCP_CALL,
            raw="mcp: read_file ok",
            metadata={"tool_name": "read_file", "status": "ok"},
        )

        events = grouper.feed(line)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.GROUP_START
        assert events[0].group.group_type == "mcp"
        assert events[0].group.command == "read_file"

    def test_output_in_group_emits_group_line(self):
        """Output lines within a group emit group_line events."""
        grouper = ActivityGrouper()
        start = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        grouper.feed(start)

        output = ClassifiedLine(
            line_type=LineType.OUTPUT, raw="  some output", metadata={}
        )
        events = grouper.feed(output)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.GROUP_LINE
        assert events[0].line == output
        assert events[0].group == grouper.current_group

    def test_output_without_group_emits_standalone(self):
        """Output lines without an active group emit standalone events."""
        grouper = ActivityGrouper()
        line = ClassifiedLine(
            line_type=LineType.OUTPUT, raw="  standalone output", metadata={}
        )

        events = grouper.feed(line)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.STANDALONE
        assert events[0].line == line

    def test_exec_succeeded_closes_group(self):
        """EXEC_SUCCEEDED closes the current group with succeeded status."""
        grouper = ActivityGrouper()
        start = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        grouper.feed(start)

        succeeded = ClassifiedLine(
            line_type=LineType.EXEC_SUCCEEDED,
            raw="succeeded in 150ms",
            metadata={"duration_ms": 150},
        )
        events = grouper.feed(succeeded)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.GROUP_END
        assert events[0].group.status == "succeeded"
        assert events[0].duration is not None
        assert grouper.current_group is None

    def test_exec_failed_closes_group(self):
        """EXEC_FAILED closes the current group with failed status."""
        grouper = ActivityGrouper()
        start = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        grouper.feed(start)

        failed = ClassifiedLine(
            line_type=LineType.EXEC_FAILED, raw="failed", metadata={}
        )
        events = grouper.feed(failed)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.GROUP_END
        assert events[0].group.status == "failed"
        assert grouper.current_group is None

    def test_new_exec_closes_previous_group(self):
        """Starting a new exec group closes the previous one."""
        grouper = ActivityGrouper()
        start1 = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        grouper.feed(start1)

        start2 = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        events = grouper.feed(start2)

        # Should get group_end for first, then group_start for second
        assert len(events) == 2
        assert events[0].event_type == OutputEventType.GROUP_END
        assert events[1].event_type == OutputEventType.GROUP_START

    def test_mcp_closes_previous_exec_group(self):
        """Starting an MCP group closes a previous exec group."""
        grouper = ActivityGrouper()
        start = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        grouper.feed(start)

        mcp = ClassifiedLine(
            line_type=LineType.MCP_CALL,
            raw="mcp: write_file done",
            metadata={"tool_name": "write_file", "status": "done"},
        )
        events = grouper.feed(mcp)

        assert len(events) == 2
        assert events[0].event_type == OutputEventType.GROUP_END
        assert events[1].event_type == OutputEventType.GROUP_START
        assert events[1].group.group_type == "mcp"

    def test_succeeded_without_group_emits_standalone(self):
        """EXEC_SUCCEEDED without an open group emits standalone."""
        grouper = ActivityGrouper()
        line = ClassifiedLine(
            line_type=LineType.EXEC_SUCCEEDED,
            raw="succeeded in 100ms",
            metadata={"duration_ms": 100},
        )

        events = grouper.feed(line)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.STANDALONE

    def test_failed_without_group_emits_standalone(self):
        """EXEC_FAILED without an open group emits standalone."""
        grouper = ActivityGrouper()
        line = ClassifiedLine(
            line_type=LineType.EXEC_FAILED, raw="failed", metadata={}
        )

        events = grouper.feed(line)

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.STANDALONE

    def test_lines_accumulate_in_group(self):
        """Lines fed to a group accumulate in its lines list."""
        grouper = ActivityGrouper()
        start = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        grouper.feed(start)

        for i in range(3):
            output = ClassifiedLine(
                line_type=LineType.OUTPUT, raw=f"line {i}", metadata={}
            )
            grouper.feed(output)

        # start line + 3 output lines = 4
        assert len(grouper.current_group.lines) == 4

    def test_flush_closes_open_group(self):
        """flush() closes an open group and returns group_end event."""
        grouper = ActivityGrouper()
        start = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        grouper.feed(start)

        events = grouper.flush()

        assert len(events) == 1
        assert events[0].event_type == OutputEventType.GROUP_END
        assert grouper.current_group is None

    def test_flush_with_no_group_returns_empty(self):
        """flush() with no open group returns empty list."""
        grouper = ActivityGrouper()
        events = grouper.flush()
        assert events == []

    def test_full_lifecycle(self):
        """Complete lifecycle: start → output → succeeded."""
        grouper = ActivityGrouper()

        start = ClassifiedLine(line_type=LineType.EXEC_START, raw="exec", metadata={})
        events = grouper.feed(start)
        assert events[0].event_type == OutputEventType.GROUP_START

        output = ClassifiedLine(
            line_type=LineType.OUTPUT, raw="  running...", metadata={}
        )
        events = grouper.feed(output)
        assert events[0].event_type == OutputEventType.GROUP_LINE

        succeeded = ClassifiedLine(
            line_type=LineType.EXEC_SUCCEEDED,
            raw="succeeded in 200ms",
            metadata={"duration_ms": 200},
        )
        events = grouper.feed(succeeded)
        assert events[0].event_type == OutputEventType.GROUP_END
        assert events[0].group.status == "succeeded"
        assert grouper.current_group is None
