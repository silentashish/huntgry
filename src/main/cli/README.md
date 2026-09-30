# `src/main/cli/` — agent CLIs and the resume-tailor skill

Runs the installed resume-tailor skill through an agent CLI — `claude -p` (stream-json),
`codex exec --json` or `agy` (stream-json) — against the open workspace (`CV_HOME`). The app
does not duplicate the skill's logic (JD parsing, LaTeX, `build.py`); it only starts the
agent, relays the conversation and records it.

| File | Role |
| --- | --- |
| `env.ts` | Locate the agent CLIs (`findCli`), the skill and TeX; compose the child PATH/env; parse `preflight.py` output. |
| `environment.ts` | Environment report for Settings (per-agent status, shared dependencies); install the Python modules into the venv. |
| `command.ts` | Claude arguments, allowed tools, system prompt, first message, start-form validation. |
| `agents/` | One adapter per agent (`claude.ts`, `codex.ts`, `antigravity.ts`): command line, stdin encoding, output signals, failure text, skill folders. `skills.ts`: skill presence per agent and "Install skill" (link, copy fallback). |
| `runner.ts` | `RunManager`: spawn, stream, reply/resume (stream and per-turn agents), stop/finish, output folder detection. |
| `runs.ts` | `.huntgry/runs/<id>/{run.json,events.jsonl}` store. |
| `start.ts` | The shared `RunManager`, the run context per agent, the default agent. |
| `ipc.ts` | `window.huntgry.runner.*` handlers. |

Adding an agent: its id in `AGENT_IDS` (`src/shared/runner-types.ts`), an adapter file here,
an entry in `agents/index.ts`, and a transcript fold in `src/shared/transcript.ts`.

See [docs/changes/8-claude-runner.md](../../../docs/changes/8-claude-runner.md) and
[docs/changes/22-multi-agent.md](../../../docs/changes/22-multi-agent.md).
