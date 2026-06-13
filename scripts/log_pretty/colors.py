"""Color/Icon engine for log_pretty.

Provides ANSI color codes, emoji icons, and helper functions
for colorized terminal output.
"""

# ANSI color constants
CYAN = "\033[96m"
BLUE = "\033[94m"
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
DIM = "\033[2m"
RESET = "\033[0m"

PALETTE: dict[str, str] = {
    "exec": CYAN,
    "mcp": BLUE,
    "success": GREEN,
    "failure": RED,
    "warning": YELLOW,
    "dim": DIM,
}

ICONS: dict[str, str] = {
    "exec": "🔧",
    "mcp": "🔌",
    "file_read": "📖",
    "search": "🔍",
    "success": "✅",
    "failure": "❌",
    "warning": "⚠️",
    "ai_response": "🤖",
}


def colorize(text: str, color_key: str, enabled: bool) -> str:
    """Wrap text with ANSI color codes.

    Args:
        text: The text to colorize.
        color_key: Key into PALETTE (e.g. "exec", "failure").
        enabled: If False, return text as-is without ANSI codes.

    Returns:
        The text wrapped with ANSI escape codes, or plain text if disabled.
    """
    if not enabled:
        return text
    color = PALETTE.get(color_key, "")
    if not color:
        return text
    return f"{color}{text}{RESET}"


def icon(key: str) -> str:
    """Return the emoji icon for the given key.

    Args:
        key: Key into ICONS dict (e.g. "exec", "success").

    Returns:
        The emoji string, or empty string if key not found.
    """
    return ICONS.get(key, "")
