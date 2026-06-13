"""Unit tests for the ElapsedTimer class."""

import time
from unittest.mock import patch

from log_pretty.timer import ElapsedTimer


class TestElapsedTimerInit:
    """Tests for initial state."""

    def test_initial_start_time_is_none(self):
        timer = ElapsedTimer()
        assert timer.start_time is None

    def test_initial_last_output_time_is_none(self):
        timer = ElapsedTimer()
        assert timer.last_output_time is None


class TestStart:
    """Tests for start() method."""

    def test_start_sets_start_time(self):
        timer = ElapsedTimer()
        timer.start()
        assert timer.start_time is not None

    def test_start_sets_last_output_time(self):
        timer = ElapsedTimer()
        timer.start()
        assert timer.last_output_time is not None

    def test_start_time_equals_last_output_time(self):
        timer = ElapsedTimer()
        timer.start()
        assert timer.start_time == timer.last_output_time


class TestElapsed:
    """Tests for elapsed() method."""

    def test_elapsed_returns_zero_when_not_started(self):
        timer = ElapsedTimer()
        assert timer.elapsed() == 0.0

    def test_elapsed_returns_positive_after_start(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 105.0]):
            timer.start()
            result = timer.elapsed()
        assert result == 5.0

    def test_elapsed_increases_over_time(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 110.0, 120.0]):
            timer.start()
            first = timer.elapsed()
            second = timer.elapsed()
        assert second > first


class TestIsWarning:
    """Tests for is_warning() method."""

    def test_not_warning_when_not_started(self):
        timer = ElapsedTimer()
        assert timer.is_warning() is False

    def test_not_warning_below_threshold(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 120.0]):
            timer.start()
            assert timer.is_warning() is False

    def test_warning_above_default_threshold(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 131.0]):
            timer.start()
            assert timer.is_warning() is True

    def test_not_warning_at_exactly_threshold(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 130.0]):
            timer.start()
            # elapsed() == 30.0, threshold is 30.0, uses > not >=
            assert timer.is_warning() is False

    def test_custom_threshold(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 111.0]):
            timer.start()
            assert timer.is_warning(threshold=10.0) is True


class TestIsStale:
    """Tests for is_stale() method."""

    def test_not_stale_when_no_output_recorded(self):
        timer = ElapsedTimer()
        assert timer.is_stale() is False

    def test_not_stale_when_recent_output(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 100.5]):
            timer.start()
            assert timer.is_stale() is False

    def test_stale_when_output_exceeds_threshold(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 103.0]):
            timer.start()
            assert timer.is_stale() is True

    def test_custom_stale_threshold(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 106.0]):
            timer.start()
            assert timer.is_stale(threshold=5.0) is True


class TestMarkOutput:
    """Tests for mark_output() method."""

    def test_mark_output_updates_last_output_time(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 105.0]):
            timer.start()
            timer.mark_output()
        assert timer.last_output_time == 105.0

    def test_mark_output_resets_stale_detection(self):
        timer = ElapsedTimer()
        with patch("log_pretty.timer.time.time", side_effect=[100.0, 105.0, 105.5]):
            timer.start()
            # After mark_output at 105.0, checking stale at 105.5 (0.5s gap) should not be stale
            timer.mark_output()
            assert timer.is_stale() is False


class TestReset:
    """Tests for reset() method."""

    def test_reset_clears_start_time(self):
        timer = ElapsedTimer()
        timer.start()
        timer.reset()
        assert timer.start_time is None

    def test_reset_clears_last_output_time(self):
        timer = ElapsedTimer()
        timer.start()
        timer.reset()
        assert timer.last_output_time is None

    def test_elapsed_returns_zero_after_reset(self):
        timer = ElapsedTimer()
        timer.start()
        timer.reset()
        assert timer.elapsed() == 0.0
