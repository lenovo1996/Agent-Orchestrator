# Feature: log-pretty-rebuild, Property 6: elapsed time warning threshold
"""Property-based test for ElapsedTimer.is_warning() threshold behavior.

Validates: Requirements 3.4

Property 6: For any elapsed time value, if the value exceeds 30 seconds
the is_warning() method must return True, and if ≤30 seconds it must
return False.
"""

from unittest.mock import patch

from hypothesis import given, settings
from hypothesis import strategies as st

from log_pretty.timer import ElapsedTimer


@given(
    elapsed_seconds=st.floats(
        min_value=0.0, max_value=120.0, allow_nan=False, allow_infinity=False
    )
)
@settings(max_examples=100)
def test_elapsed_time_warning_threshold(elapsed_seconds: float) -> None:
    """Property 6: elapsed time warning threshold.

    For any elapsed time > 30 seconds, is_warning() must return True.
    For any elapsed time <= 30 seconds, is_warning() must return False.

    **Validates: Requirements 3.4**
    """
    start_time = 1000.0
    current_time = start_time + elapsed_seconds

    timer = ElapsedTimer()

    with patch("log_pretty.timer.time.time", side_effect=[start_time, current_time]):
        timer.start()
        result = timer.is_warning()

    if elapsed_seconds > 30.0:
        assert result is True, (
            f"Expected is_warning()=True for elapsed={elapsed_seconds}s (>30s), got False"
        )
    else:
        assert result is False, (
            f"Expected is_warning()=False for elapsed={elapsed_seconds}s (<=30s), got True"
        )
