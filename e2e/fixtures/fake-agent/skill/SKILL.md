---
name: resume-tailor
description: Fixture copy of the resume-tailor skill for the e2e suite. The fake agent CLIs never read it; the app only needs the folder and this file to exist.
---

# resume-tailor (e2e fixture)

Stand-in for the real skill (silentashish/claude-resume-generator-skill). It has the two
things Huntgry looks for: this `SKILL.md` under `resume-tailor/`, and `scripts/preflight.py`,
which reports every dependency as present. The scripted agents in `../agent.mjs` play the
skill's flow themselves (gap analysis, approval question, build).
