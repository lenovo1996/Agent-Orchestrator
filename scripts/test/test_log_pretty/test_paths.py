"""Property-based tests for log_pretty.paths module.

Tests Property 12 (path shortening correctness) and Property 13 (same-directory grouping)
using Hypothesis strategies.
"""

import os

from hypothesis import given, settings
from hypothesis import strategies as st

from log_pretty.paths import group_file_operations, shorten_path


# ---------------------------------------------------------------------------
# Custom strategies
# ---------------------------------------------------------------------------


@st.composite
def st_file_path(draw, project_root="/home/user/project"):
    """Generate random absolute paths under a project root.

    Generates paths with varying depth and component lengths to cover
    both short paths (under 50 chars after relativization) and long paths.
    """
    # Number of path components after root
    depth = draw(st.integers(min_value=1, max_value=8))

    # Generate path components with varying lengths
    components = []
    for _ in range(depth):
        component = draw(
            st.from_regex(r"[a-zA-Z][a-zA-Z0-9_\-]{0,25}", fullmatch=True)
        )
        components.append(component)

    # Ensure last component looks like a filename
    extension = draw(st.sampled_from([".py", ".js", ".ts", ".php", ".md", ".txt", ".json"]))
    filename = draw(
        st.from_regex(r"[a-zA-Z][a-zA-Z0-9_\-]{0,20}", fullmatch=True)
    )
    components[-1] = filename + extension

    path = project_root.rstrip("/") + "/" + "/".join(components)
    return path


@st.composite
def st_short_path(draw, project_root="/home/user/project"):
    """Generate paths that will be short (<=50 chars) after relativization."""
    # Use short component names to keep relative path under 50 chars
    depth = draw(st.integers(min_value=1, max_value=3))
    components = []
    for _ in range(depth):
        component = draw(
            st.from_regex(r"[a-z]{1,8}", fullmatch=True)
        )
        components.append(component)

    extension = draw(st.sampled_from([".py", ".js", ".ts"]))
    filename = draw(st.from_regex(r"[a-z]{1,8}", fullmatch=True))
    components[-1] = filename + extension

    path = project_root.rstrip("/") + "/" + "/".join(components)
    return path


@st.composite
def st_long_path(draw, project_root="/home/user/project"):
    """Generate paths that will exceed 50 chars after relativization."""
    # Use longer component names and more depth to ensure >50 chars relative
    depth = draw(st.integers(min_value=4, max_value=8))
    components = []
    for _ in range(depth):
        component = draw(
            st.from_regex(r"[a-zA-Z][a-zA-Z0-9_]{5,20}", fullmatch=True)
        )
        components.append(component)

    extension = draw(st.sampled_from([".py", ".js", ".ts", ".php"]))
    filename = draw(st.from_regex(r"[a-zA-Z][a-zA-Z0-9_]{5,15}", fullmatch=True))
    components[-1] = filename + extension

    path = project_root.rstrip("/") + "/" + "/".join(components)
    return path


@st.composite
def st_same_directory_paths(draw):
    """Generate a list of file paths that all share the same parent directory."""
    # Generate the shared directory
    dir_depth = draw(st.integers(min_value=1, max_value=4))
    dir_components = []
    for _ in range(dir_depth):
        component = draw(st.from_regex(r"[a-z][a-z0-9_]{1,12}", fullmatch=True))
        dir_components.append(component)
    shared_dir = "/".join(dir_components)

    # Generate 2-10 filenames in that directory
    num_files = draw(st.integers(min_value=2, max_value=10))
    filenames = []
    for _ in range(num_files):
        extension = draw(st.sampled_from([".py", ".js", ".ts", ".php", ".md"]))
        name = draw(st.from_regex(r"[A-Z][a-zA-Z0-9]{1,15}", fullmatch=True))
        filenames.append(name + extension)

    # Ensure unique filenames
    filenames = list(dict.fromkeys(filenames))
    if len(filenames) < 2:
        filenames.append("Extra.py")

    paths = [f"{shared_dir}/{fn}" for fn in filenames]
    return paths


# ---------------------------------------------------------------------------
# Property 12: Path shortening correctness
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 12: Path shortening correctness
@given(path=st_file_path(project_root="/home/user/project"))
@settings(max_examples=100)
def test_shorten_path_removes_leading_slash(path):
    """For any absolute path starting with project_root,
    shorten_path must return a string not starting with '/'."""
    project_root = "/home/user/project"
    result = shorten_path(path, project_root)
    assert not result.startswith("/"), (
        f"shorten_path returned '{result}' which starts with '/' "
        f"for path '{path}' with root '{project_root}'"
    )


# Feature: log-pretty-rebuild, Property 12: Path shortening correctness
@given(path=st_long_path(project_root="/home/user/project"))
@settings(max_examples=100)
def test_shorten_path_long_paths_use_ellipsis_pattern(path):
    """For any path where the relative form exceeds 50 characters,
    the output must match the pattern '.../parent/filename'."""
    project_root = "/home/user/project"
    # First compute relative to check if it actually exceeds 50 chars
    normalized_root = project_root.rstrip(os.sep) + os.sep
    relative = path[len(normalized_root):]

    result = shorten_path(path, project_root)

    if len(relative) > 50:
        # Must match .../parent/filename pattern
        assert result.startswith(".../"), (
            f"Long path (relative len={len(relative)}) should start with '...' "
            f"but got '{result}'"
        )
        parts = result.split("/")
        assert len(parts) == 3, (
            f"Expected pattern '.../parent/filename' (3 parts) "
            f"but got {len(parts)} parts: '{result}'"
        )
        assert parts[0] == "...", f"First part should be '...' but got '{parts[0]}'"


# Feature: log-pretty-rebuild, Property 12: Path shortening correctness
@given(path=st_short_path(project_root="/home/user/project"))
@settings(max_examples=100)
def test_shorten_path_short_paths_stay_relative(path):
    """For paths under 50 chars after relativization, result should be the
    relative path (no ellipsis shortening applied)."""
    project_root = "/home/user/project"
    normalized_root = project_root.rstrip(os.sep) + os.sep
    relative = path[len(normalized_root):]

    result = shorten_path(path, project_root)

    if len(relative) <= 50:
        # Should return the plain relative path
        assert result == relative, (
            f"Short path (relative len={len(relative)}) should return "
            f"plain relative '{relative}' but got '{result}'"
        )
        assert not result.startswith("/")


# ---------------------------------------------------------------------------
# Property 13: Same-directory file grouping
# ---------------------------------------------------------------------------


# Feature: log-pretty-rebuild, Property 13: Same-directory file grouping
@given(paths=st_same_directory_paths())
@settings(max_examples=100)
def test_group_file_operations_directory_appears_once(paths):
    """For any list of file paths sharing the same parent directory,
    group_file_operations must output the directory name exactly once."""
    result = group_file_operations(paths)

    # The shared directory should appear exactly once (as the first entry)
    # Extract parent directory from the first input path
    first_path = paths[0]
    last_slash = first_path.rfind("/")
    shared_dir = first_path[:last_slash] if last_slash != -1 else ""

    # Count how many lines in result contain the full directory path as a standalone entry
    dir_entries = [
        line for line in result
        if line.rstrip("/") == shared_dir or line.rstrip("/") == shared_dir + "/"
            or line == shared_dir + "/"
    ]
    assert len(dir_entries) == 1, (
        f"Expected directory '{shared_dir}' to appear exactly once, "
        f"but found {len(dir_entries)} times in result: {result}"
    )


# Feature: log-pretty-rebuild, Property 13: Same-directory file grouping
@given(paths=st_same_directory_paths())
@settings(max_examples=100)
def test_group_file_operations_only_basenames_after_directory(paths):
    """For any list of file paths sharing the same parent directory,
    after the directory header, only base filenames should appear."""
    result = group_file_operations(paths)

    # First line is the directory header
    # Remaining lines should be indented base filenames
    assert len(result) >= 2, f"Expected at least 2 lines in result, got {len(result)}"

    # All lines after the directory header should be indented filenames
    for line in result[1:]:
        stripped = line.strip()
        # Should be a basename (no path separators)
        assert "/" not in stripped, (
            f"Expected only base filenames after directory header, "
            f"but got '{line}' which contains '/'"
        )
        # Should be indented (starts with spaces)
        assert line.startswith("  "), (
            f"Expected indented filename, but '{line}' doesn't start with spaces"
        )
