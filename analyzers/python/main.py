"""Entry point: `python -I main.py manifest | analyze --root <path> …` (D-057).

Run with -I: the analyzer reads the project's sources as text and must not import anything from the project or from
the user's environment. In isolated mode the folder of this script is not on sys.path, so it is added here.
"""
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension or the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.setrecursionlimit(10000)

from nomos_python.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
