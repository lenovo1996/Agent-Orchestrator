"""Unit tests for the LogFollower class."""

import os
import tempfile

import pytest

from log_pretty.follower import LogFollower


class TestLogFollowerInit:
    """Test LogFollower initialization."""

    def test_default_poll_interval(self):
        follower = LogFollower("/tmp/nonexistent.log")
        assert follower.poll_interval == 0.1
        assert follower.last_inode is None
        assert follower.file is None
        assert follower.on_rotation is False
        assert follower.on_waiting is False

    def test_custom_poll_interval(self):
        follower = LogFollower("/tmp/test.log", poll_interval=0.5)
        assert follower.poll_interval == 0.5


class TestLogFollowerWaiting:
    """Test waiting state when file doesn't exist."""

    def test_yields_none_when_file_missing(self):
        follower = LogFollower("/tmp/nonexistent_file_xyz_12345.log")
        gen = follower.lines()
        result = next(gen)
        assert result is None
        assert follower.on_waiting is True
        follower.close()

    def test_yields_none_on_permission_error(self, tmp_path):
        # Create a file with no read permissions
        log_file = tmp_path / "noperm.log"
        log_file.write_text("test line\n")
        os.chmod(str(log_file), 0o000)

        try:
            follower = LogFollower(str(log_file))
            gen = follower.lines()
            result = next(gen)
            assert result is None
            assert follower.on_waiting is True
            follower.close()
        finally:
            # Restore permissions for cleanup
            os.chmod(str(log_file), 0o644)


class TestLogFollowerReading:
    """Test reading lines from an existing file."""

    def test_reads_new_lines_after_open(self, tmp_path):
        log_file = tmp_path / "test.log"
        log_file.write_text("existing content\n")

        follower = LogFollower(str(log_file))
        gen = follower.lines()

        # First call opens file and seeks to end — no new content
        result = next(gen)
        assert result is None
        assert follower.on_waiting is False

        # Now append a new line
        with open(str(log_file), "a") as f:
            f.write("new line\n")

        # Should yield the new line
        result = next(gen)
        assert result == "new line"
        follower.close()

    def test_reads_multiple_lines(self, tmp_path):
        log_file = tmp_path / "test.log"
        log_file.write_text("")

        follower = LogFollower(str(log_file))
        gen = follower.lines()

        # Open, seek to end — nothing to read
        next(gen)

        # Write multiple lines
        with open(str(log_file), "a") as f:
            f.write("line 1\n")
            f.write("line 2\n")
            f.write("line 3\n")

        results = []
        for _ in range(3):
            r = next(gen)
            if r is not None:
                results.append(r)

        assert results == ["line 1", "line 2", "line 3"]
        follower.close()

    def test_strips_newline_from_lines(self, tmp_path):
        log_file = tmp_path / "test.log"
        log_file.write_text("")

        follower = LogFollower(str(log_file))
        gen = follower.lines()
        next(gen)  # initial open

        with open(str(log_file), "a") as f:
            f.write("no trailing newline\n")

        result = next(gen)
        assert result == "no trailing newline"
        assert not result.endswith("\n")
        follower.close()


class TestLogFollowerRotation:
    """Test symlink rotation detection."""

    def test_detects_symlink_rotation(self, tmp_path):
        # Create first log file
        log1 = tmp_path / "agent1.log"
        log1.write_text("initial content\n")

        # Create symlink
        symlink = tmp_path / "current.log"
        symlink.symlink_to(log1)

        follower = LogFollower(str(symlink))
        gen = follower.lines()

        # First call — opens and seeks to end
        next(gen)
        assert follower.on_rotation is False

        # Write to first file
        with open(str(log1), "a") as f:
            f.write("line from file 1\n")
        result = next(gen)
        assert result == "line from file 1"

        # Create second log file and update symlink
        log2 = tmp_path / "agent2.log"
        log2.write_text("content from file 2\n")

        # Remove old symlink and create new one
        symlink.unlink()
        symlink.symlink_to(log2)

        # Next call should detect rotation
        # May need a few iterations since _check_rotation is called on no-data
        result = next(gen)
        # After rotation, it reopens and seeks to end — yields None
        # The on_rotation flag should be set
        assert follower.on_rotation is True
        follower.close()

    def test_detects_file_recreation(self, tmp_path):
        log_file = tmp_path / "test.log"
        log_file.write_text("original\n")

        follower = LogFollower(str(log_file))
        gen = follower.lines()
        next(gen)  # open

        # Delete and recreate with different inode
        log_file.unlink()
        log_file.write_text("recreated\n")

        # Should detect the inode change
        result = next(gen)
        assert follower.on_rotation is True
        follower.close()


class TestLogFollowerDeletion:
    """Test handling file deletion while following."""

    def test_returns_to_waiting_on_deletion(self, tmp_path):
        log_file = tmp_path / "test.log"
        log_file.write_text("content\n")

        follower = LogFollower(str(log_file))
        gen = follower.lines()
        next(gen)  # open file

        # Delete the file
        log_file.unlink()

        # Should enter waiting state
        result = next(gen)
        assert result is None
        assert follower.on_waiting is True
        follower.close()


class TestLogFollowerClose:
    """Test close() method."""

    def test_close_cleans_up(self, tmp_path):
        log_file = tmp_path / "test.log"
        log_file.write_text("data\n")

        follower = LogFollower(str(log_file))
        gen = follower.lines()
        next(gen)  # open file

        assert follower.file is not None

        follower.close()
        assert follower.file is None
        assert follower.last_inode is None
        assert follower.on_rotation is False
        assert follower.on_waiting is False

    def test_close_when_no_file_open(self):
        follower = LogFollower("/tmp/nonexistent.log")
        # Should not raise
        follower.close()
        assert follower.file is None
