"""Elapsed timer for tracking command execution duration.

Provides the ElapsedTimer class for measuring elapsed time,
detecting stale output, and triggering time-based warnings.
"""

import time


class ElapsedTimer:
    """Track elapsed time for an activity group.

    Used by the formatter to display elapsed time and by the main
    controller to detect stale output (no new lines for a threshold).
    """

    def __init__(self) -> None:
        self.start_time: float | None = None
        self.last_output_time: float | None = None

    def start(self) -> None:
        """Record start time and initialize last_output_time."""
        self.start_time = time.time()
        self.last_output_time = self.start_time

    def elapsed(self) -> float:
        """Return elapsed seconds since start.

        Returns:
            Seconds elapsed since start() was called, or 0.0 if not started.
        """
        if self.start_time is None:
            return 0.0
        return time.time() - self.start_time

    def is_warning(self, threshold: float = 30.0) -> bool:
        """Return True if elapsed time exceeds threshold.

        Args:
            threshold: Warning threshold in seconds (default 30s).

        Returns:
            True if elapsed time exceeds the threshold, False otherwise.
        """
        return self.elapsed() > threshold

    def is_stale(self, threshold: float = 2.0) -> bool:
        """Return True if time since last output exceeds threshold.

        Args:
            threshold: Stale threshold in seconds (default 2s).

        Returns:
            True if no output has been recorded for longer than
            threshold seconds, False otherwise.
        """
        if self.last_output_time is None:
            return False
        return (time.time() - self.last_output_time) > threshold

    def mark_output(self) -> None:
        """Record that output was just received.

        Updates last_output_time to current time.
        """
        self.last_output_time = time.time()

    def reset(self) -> None:
        """Reset the timer to its initial state."""
        self.start_time = None
        self.last_output_time = None
