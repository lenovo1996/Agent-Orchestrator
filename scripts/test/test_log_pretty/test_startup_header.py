"""Tests for startup header logic in __main__.py.

Tests _find_workflow_json and _parse_workflow_json functions.
"""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from log_pretty.__main__ import _find_workflow_json, _parse_workflow_json


class TestFindWorkflowJson:
    """Tests for _find_workflow_json discovery logic."""

    def test_finds_workflow_in_same_directory(self, tmp_path):
        """workflow.json in same dir as log file is found."""
        workflow = tmp_path / "workflow.json"
        workflow.write_text('{"flowId": "test"}')
        log_file = str(tmp_path / "agent.log")

        result = _find_workflow_json(log_file)
        assert result == str(workflow)

    def test_finds_workflow_walking_up(self, tmp_path):
        """workflow.json in a parent directory is found."""
        workflow = tmp_path / "workflow.json"
        workflow.write_text('{"flowId": "test"}')
        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()
        log_file = str(logs_dir / "agent.log")

        result = _find_workflow_json(log_file)
        assert result == str(workflow)

    def test_finds_workflow_in_task_flows(self, tmp_path):
        """workflow.json in .dev-team/task-flows/* is found when walk-up fails."""
        # Create .dev-team/task-flows/flow_xxx/workflow.json
        flow_dir = tmp_path / ".dev-team" / "task-flows" / "flow_123"
        flow_dir.mkdir(parents=True)
        workflow = flow_dir / "workflow.json"
        workflow.write_text('{"flowId": "flow_123"}')

        # Log file is in a different location under tmp_path
        other_dir = tmp_path / "somewhere" / "else"
        other_dir.mkdir(parents=True)
        log_file = str(other_dir / "agent.log")

        result = _find_workflow_json(log_file)
        assert result == str(workflow)

    def test_returns_none_when_not_found(self, tmp_path):
        """Returns None when no workflow.json exists anywhere."""
        log_file = str(tmp_path / "agent.log")

        result = _find_workflow_json(log_file)
        assert result is None

    def test_does_not_exceed_walk_up_limit(self, tmp_path):
        """Stops walking up after 5 levels (doesn't traverse indefinitely)."""
        # Create deeply nested log dir (more than 5 levels)
        deep_dir = tmp_path / "a" / "b" / "c" / "d" / "e" / "f" / "g"
        deep_dir.mkdir(parents=True)

        # Put workflow.json at root (more than 5 levels up from deep_dir)
        workflow = tmp_path / "workflow.json"
        workflow.write_text('{"flowId": "root"}')

        log_file = str(deep_dir / "agent.log")
        # The walk-up from deep_dir goes: f, e, d, c, b — 5 levels
        # "a" is 6 levels up, tmp_path is 7 levels up
        # But strategy 2 (task-flows search) may still find it if .dev-team exists
        # Since there's no .dev-team here, it won't find via strategy 2 either
        # But walk-up from 'g' goes: f, e, d, c, b — that's 5 checks
        # tmp_path would require going up 7 dirs from 'g'
        # Let's verify: from g → f (1), e (2), d (3), c (4), b (5) = stops
        # workflow is at tmp_path level which is 7 levels up from g
        result = _find_workflow_json(log_file)
        # It should still find it because strategy 2 walks up 10 levels
        # looking for .dev-team/task-flows. Since there's no .dev-team either,
        # it should return None
        assert result is None


class TestParseWorkflowJson:
    """Tests for _parse_workflow_json parsing logic."""

    def test_parses_valid_workflow(self, tmp_path):
        """Correctly extracts fields from a valid workflow.json."""
        workflow = tmp_path / "workflow.json"
        data = {
            "flowId": "flow_20260604121229_JH-40515",
            "jiraKey": "JH-40515",
            "status": "running",
            "currentStep": "architect",
            "startedAt": "2026-06-04T05:12:29.903Z",
        }
        workflow.write_text(json.dumps(data))

        result = _parse_workflow_json(str(workflow))

        assert result["flow_id"] == "flow_20260604121229_JH-40515"
        assert result["jira_key"] == "JH-40515"
        assert result["current_step"] == "architect"
        assert result["status"] == "running"

    def test_handles_missing_fields(self, tmp_path):
        """Returns defaults for missing fields."""
        workflow = tmp_path / "workflow.json"
        workflow.write_text('{"flowId": "test_flow"}')

        result = _parse_workflow_json(str(workflow))

        assert result["flow_id"] == "test_flow"
        assert result["jira_key"] is None
        assert result["current_step"] == ""
        assert result["status"] == ""

    def test_handles_malformed_json(self, tmp_path):
        """Returns defaults for malformed JSON."""
        workflow = tmp_path / "workflow.json"
        workflow.write_text("not valid json {{{")

        result = _parse_workflow_json(str(workflow))

        assert result["flow_id"] == ""
        assert result["jira_key"] is None
        assert result["current_step"] == ""
        assert result["status"] == ""

    def test_handles_non_dict_json(self, tmp_path):
        """Returns defaults when JSON is valid but not an object."""
        workflow = tmp_path / "workflow.json"
        workflow.write_text("[1, 2, 3]")

        result = _parse_workflow_json(str(workflow))

        assert result["flow_id"] == ""
        assert result["jira_key"] is None

    def test_handles_nonexistent_file(self, tmp_path):
        """Returns defaults for non-existent file path."""
        result = _parse_workflow_json(str(tmp_path / "nope.json"))

        assert result["flow_id"] == ""
        assert result["jira_key"] is None
        assert result["current_step"] == ""

    def test_handles_empty_jira_key(self, tmp_path):
        """Empty string jiraKey is treated as None."""
        workflow = tmp_path / "workflow.json"
        workflow.write_text('{"flowId": "x", "jiraKey": ""}')

        result = _parse_workflow_json(str(workflow))

        assert result["jira_key"] is None

    def test_handles_numeric_jira_key(self, tmp_path):
        """Non-string jiraKey is treated as None."""
        workflow = tmp_path / "workflow.json"
        workflow.write_text('{"flowId": "x", "jiraKey": 123}')

        result = _parse_workflow_json(str(workflow))

        assert result["jira_key"] is None
