# `src/main/cli/` — the `claude` CLI and the resume-tailor skill

Runs the installed resume-tailor skill through `claude -p` in stream-json mode, against
the open workspace (`CV_HOME`). The app does not duplicate the skill's logic (JD parsing,
LaTeX, `build.py`); it only starts Claude, relays the conversation and records it.

| File | Role |
| --- | --- |
| `env.ts` | Locate `claude`, the skill and TeX; compose the child PATH/env; parse `preflight.py` output. |
| `environment.ts` | Environment report for Settings; install the Python modules into the venv. |
| `command.ts` | Arguments, allowed tools, system prompt, first message, start-form validation. |
| `runner.ts` | `RunManager`: spawn, stream, reply/resume, stop/finish, output folder detection. |
| `runs.ts` | `.huntgry/runs/<id>/{run.json,events.jsonl}` store. |
| `ipc.ts` | `window.huntgry.runner.*` handlers. |

See [docs/changes/8-claude-runner.md](../../../docs/changes/8-claude-runner.md).
