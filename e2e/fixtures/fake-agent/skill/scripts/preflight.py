#!/usr/bin/env python3
"""Fixture preflight for the e2e suite: every dependency reports as present.

Prints the lines `parsePreflight` (src/main/cli/env.ts) understands, in the real
script's format: `ok <name>`, `MISSING <name> - <why>`, `-- <name> <note>`.
"""
import sys

for name in ("python3", "pydantic", "jinja2", "pymupdf", "python-docx", "pdflatex", "pdftotext"):
    print(f"ok    {name}")
print("--    docx2pdf (optional) not needed on this platform")
sys.exit(0)
