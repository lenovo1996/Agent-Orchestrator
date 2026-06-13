"""Path Shortener for log_pretty.

Provides utilities for shortening absolute file paths to relative forms
and grouping consecutive same-directory file operations.
"""

import os


def shorten_path(path: str, project_root: str, max_length: int = 50) -> str:
    """Convert absolute path to short relative form.

    1. If path starts with project_root, strip it to make relative.
    2. If the resulting relative path exceeds max_length, shorten to .../parent/filename.
    3. If path doesn't start with project_root, try .../parent/filename if long.

    Args:
        path: The file path to shorten.
        project_root: The project root directory (used to make paths relative).
        max_length: Maximum allowed length before applying .../parent/filename.

    Returns:
        A shortened path string.
    """
    if not path:
        return path

    # Normalize project_root to ensure consistent trailing slash handling
    normalized_root = project_root.rstrip(os.sep) + os.sep

    # Step 1: If path starts with project_root, make it relative
    if path.startswith(normalized_root):
        relative = path[len(normalized_root):]
    elif path == project_root.rstrip(os.sep):
        # Path is exactly the project root
        return "."
    else:
        relative = path

    # Step 2/3: If the path exceeds max_length, shorten to .../parent/filename
    if len(relative) > max_length:
        parts = relative.replace("\\", "/").split("/")
        if len(parts) >= 2:
            parent = parts[-2]
            filename = parts[-1]
            return f".../{parent}/{filename}"
        else:
            # Single component that's too long — just return it
            return relative

    return relative


def group_file_operations(paths: list[str]) -> list[str]:
    """Group consecutive same-directory operations.

    When multiple file paths share the same parent directory,
    output the directory name once followed by only the base filenames.

    Single files in a directory are output as-is (no grouping).

    Example:
        Input: ["src/models/User.php", "src/models/Role.php", "src/models/Permission.php"]
        Output: ["src/models/", "  User.php", "  Role.php", "  Permission.php"]

    Args:
        paths: List of file path strings.

    Returns:
        List of formatted strings with directory grouping applied.
    """
    if not paths:
        return []

    result: list[str] = []

    # Collect consecutive runs of same-directory paths
    i = 0
    while i < len(paths):
        current_path = paths[i]
        current_dir = _get_parent_dir(current_path)
        current_basename = _get_basename(current_path)

        # Look ahead to find all consecutive paths in the same directory
        group_start = i
        i += 1
        while i < len(paths) and _get_parent_dir(paths[i]) == current_dir:
            i += 1

        group_size = i - group_start

        if group_size >= 2 and current_dir:
            # Multiple files in same directory — group them
            dir_display = current_dir if current_dir.endswith("/") else current_dir + "/"
            result.append(dir_display)
            for j in range(group_start, group_start + group_size):
                result.append(f"  {_get_basename(paths[j])}")
        else:
            # Single file or no meaningful directory — output each as-is
            for j in range(group_start, group_start + group_size):
                result.append(paths[j])

    return result


def _get_parent_dir(path: str) -> str:
    """Extract parent directory from a path string.

    Uses forward-slash splitting to handle both Unix and display paths.
    """
    # Normalize to forward slashes for consistent handling
    normalized = path.replace("\\", "/")
    last_slash = normalized.rfind("/")
    if last_slash == -1:
        return ""
    return normalized[:last_slash]


def _get_basename(path: str) -> str:
    """Extract the filename (basename) from a path string."""
    normalized = path.replace("\\", "/")
    last_slash = normalized.rfind("/")
    if last_slash == -1:
        return path
    return normalized[last_slash + 1:]
