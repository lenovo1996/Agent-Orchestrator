#!/usr/bin/env python3
"""Pretty log formatter for live log panel.

This script is a thin wrapper around the log_pretty package.
Run directly or via: python -m log_pretty <log-file>
"""

import sys
import os

# Ensure the package is importable from the scripts directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from log_pretty.__main__ import main

if __name__ == "__main__":
    main()
