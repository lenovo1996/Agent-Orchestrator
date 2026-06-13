"""CLI argument parsing for log_pretty.

Handles command-line argument parsing, NO_COLOR environment variable
detection, and returns a Config dataclass instance.
"""

import argparse
import os
from dataclasses import dataclass


@dataclass
class Config:
    """Configuration for the log pretty formatter.

    Attributes:
        log_file: Path to the log file to follow.
        no_collapse: If True, disable all output collapsing.
        no_color: If True, output plain text without ANSI codes.
        verbose: If True, show extra metadata (full paths, raw timestamps).
    """

    log_file: str
    no_collapse: bool = False
    no_color: bool = False
    verbose: bool = False


def parse_args(argv: list[str] | None = None) -> Config:
    """Parse command-line arguments and return a Config instance.

    Args:
        argv: List of arguments to parse. If None, uses sys.argv[1:].

    Returns:
        A Config dataclass with all parsed options.
    """
    parser = argparse.ArgumentParser(
        prog="log-pretty",
        description="Structured log formatter for dev-team automation logs.",
    )

    parser.add_argument(
        "log_file",
        metavar="<log-file>",
        help="Path to the log file to follow and format.",
    )

    parser.add_argument(
        "--no-collapse",
        action="store_true",
        default=False,
        help="Disable smart collapsing — show all output lines.",
    )

    parser.add_argument(
        "--no-color",
        action="store_true",
        default=False,
        help="Disable ANSI color codes in output.",
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Show extra metadata (full paths, raw timestamps).",
    )

    args = parser.parse_args(argv)

    # Detect NO_COLOR environment variable (https://no-color.org/)
    no_color = args.no_color or os.environ.get("NO_COLOR", "") != ""

    return Config(
        log_file=args.log_file,
        no_collapse=args.no_collapse,
        no_color=no_color,
        verbose=args.verbose,
    )
