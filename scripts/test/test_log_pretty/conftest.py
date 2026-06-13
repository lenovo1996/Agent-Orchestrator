"""Shared fixtures and configuration for log_pretty tests."""

import sys
from pathlib import Path

import pytest
from hypothesis import settings

# Ensure log_pretty package is importable from tests
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Default hypothesis profile: minimum 100 examples per property test
settings.register_profile("default", max_examples=100)
settings.register_profile("ci", max_examples=200)
settings.load_profile("default")


@pytest.fixture
def sample_project_root(tmp_path):
    """Provide a temporary project root directory for path-related tests."""
    return str(tmp_path)


@pytest.fixture
def no_color_config():
    """Provide a Config with no_color=True for color-disabled tests."""
    from log_pretty.cli import Config
    return Config(log_file="/tmp/test.log", no_color=True)


@pytest.fixture
def default_config():
    """Provide a default Config for standard tests."""
    from log_pretty.cli import Config
    return Config(log_file="/tmp/test.log")


@pytest.fixture
def verbose_config():
    """Provide a Config with verbose=True."""
    from log_pretty.cli import Config
    return Config(log_file="/tmp/test.log", verbose=True)


@pytest.fixture
def no_collapse_config():
    """Provide a Config with no_collapse=True."""
    from log_pretty.cli import Config
    return Config(log_file="/tmp/test.log", no_collapse=True)
