# `src/main/cli/` — placeholder

Reserved for the future integration with CLI agents (the `claude` CLI and the
`resume-tailor` skill). No code lives here yet, by design: the app must not
duplicate the skill's business logic (JD parsing, LaTeX, `build.py`).

Planned shape:

- Spawn `claude` from the main process with `cwd` set to the workspace root and
  `CV_HOME=<workspace path>` in the environment, so the skill writes
  `<role>/<company>/<job-id>/` folders into the workspace instead of `~/cv`.
- Stream stdout/stderr to the renderer over a dedicated IPC channel.
- The workspace's `CLAUDE.md` (written on Create) already tells Claude Code
  which directory is `CV_HOME` and which file is the master profile.
