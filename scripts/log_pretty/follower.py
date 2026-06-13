"""Log file follower with inode tracking and symlink rotation detection."""

from __future__ import annotations

import os
from typing import IO, Iterator


class LogFollower:
    """Follow a log file, handling symlink rotation and file absence.

    The follower yields lines from the log file as they appear. It handles:
    - File not existing yet (waiting state)
    - Symlink rotation (inode change detection)
    - File deletion while following
    - Permission errors

    The caller is responsible for sleeping between polls when None is yielded.
    """

    def __init__(self, path: str, poll_interval: float = 0.1):
        self.path = path
        self.poll_interval = poll_interval
        self.last_inode: int | None = None
        self.file: IO | None = None
        self.on_rotation: bool = False
        self.on_waiting: bool = False

    def lines(self) -> Iterator[str | None]:
        """Yield lines from the log file, handling inode changes and file absence.

        Yields:
            str: when a new line is available
            None: when no new line is available (caller should sleep/handle)
        """
        while True:
            # Reset per-iteration flags
            self.on_rotation = False
            self.on_waiting = False

            # Try to open/check the file
            try:
                current_inode = os.stat(self.path).st_ino
            except FileNotFoundError:
                # File doesn't exist — enter waiting state
                if self.file:
                    self.file.close()
                    self.file = None
                    self.last_inode = None
                self.on_waiting = True
                yield None
                continue
            except PermissionError:
                # Cannot access file — enter waiting state
                if self.file:
                    self.file.close()
                    self.file = None
                    self.last_inode = None
                self.on_waiting = True
                yield None
                continue

            # Check for inode change (symlink rotation or file recreation)
            if current_inode != self.last_inode:
                if self.file:
                    self.file.close()
                self.file = self._open_file()
                if self.file is None:
                    # Failed to open — waiting state
                    self.last_inode = None
                    self.on_waiting = True
                    yield None
                    continue
                # Mark rotation if we had a previous inode (not first open)
                if self.last_inode is not None:
                    self.on_rotation = True
                self.last_inode = current_inode

            # Read available lines
            if self.file:
                line = self._read_line()
                if line is not None:
                    yield line
                else:
                    # No new content — check if file was deleted or rotated
                    if self._check_rotation():
                        # File rotated, loop back to reopen
                        continue
                    yield None
            else:
                self.on_waiting = True
                yield None

    def _open_file(self) -> IO | None:
        """Open the log file and seek to end. Returns None on failure."""
        try:
            f = open(self.path, "r", encoding="utf-8", errors="replace")
            f.seek(0, 2)  # Seek to end
            return f
        except FileNotFoundError:
            return None
        except PermissionError:
            return None

    def _read_line(self) -> str | None:
        """Read a single line from the open file. Returns None if no data."""
        if self.file is None:
            return None
        try:
            line = self.file.readline()
            if line:
                return line.rstrip("\n")
            return None
        except (IOError, ValueError):
            # File handle became invalid
            self.file = None
            self.last_inode = None
            return None

    def _check_rotation(self) -> bool:
        """Check if symlink/file changed since last open. Reopen if needed.

        Returns:
            True if rotation was detected (caller should re-enter the loop).
            False if no rotation detected.
        """
        try:
            current_inode = os.stat(self.path).st_ino
            if current_inode != self.last_inode:
                # Inode changed — file was rotated
                return True
        except FileNotFoundError:
            # File was deleted
            if self.file:
                self.file.close()
                self.file = None
            self.last_inode = None
            return True
        except PermissionError:
            return False
        return False

    def close(self) -> None:
        """Clean up file handles."""
        if self.file:
            self.file.close()
            self.file = None
        self.last_inode = None
        self.on_rotation = False
        self.on_waiting = False
