# #144 — Runs could not read or run the skill when the Claude account's skills folder is a link

Issue: [silentashish/huntgry#144](https://github.com/silentashish/huntgry/issues/144)

## Context & problem

Since the Claude account picker (#140), a run looks for the resume-tailor skill in the chosen
account's folder first (`skillSearchRoots`). With the account `~/.claude-personal`, the skill is
found at `~/.claude-personal/skills/resume-tailor`, and on a typical setup `~/.claude-personal/skills`
is a symlink to `~/.claude/skills`, so every account sees one copy of the skill.

The run's allowlist, sandbox and system prompt were all built from that linked spelling, and the
agent could not use the skill at all:

- **Sandbox.** The sandbox denies reads under `~/` except the workspace, the skill, the venv and
  TeX. Both the linked folder and its real target were allowed, but Seatbelt (macOS) checks each
  symlink it follows, and the link node `~/.claude-personal/skills` was not readable.
  `python3 …/scripts/build.py` failed with `[Errno 1] Operation not permitted`.
- **Permission rules.** Claude Code matches a `Read` against the resolved path, while the rule
  named only the linked one: `Read(//…/.claude-personal/skills/resume-tailor/**)`. Reading
  `SKILL.md` needed approval, which a headless run refuses. When the agent tried the real path
  itself, neither the `Read` nor `python3 <real path>/scripts/build.py` matched a rule either.

An unattended run wrote its drafts and review notes, then stopped with no PDFs and listed the
calls under **Blocked tool calls**.

Reproduced with `sandbox-exec`: denying `~/` and allowing both skill paths fails through the link
and works on the real path. Also allowing the link node makes both work.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Run paths | `src/main/cli/command.ts` | New `resolveRunPaths`: the skill folder at its `realpath`, and the sandbox paths with each given spelling next to its real target (as before, for a linked venv, workspace or TeX root). |
| Run context | `src/main/cli/start.ts` | `context()` (Claude) and `otherAgentContext()` (Codex, Antigravity, whose skill is a link to the Claude copy) take the skill folder from `resolveRunPaths`. The allowlist, the sandbox and the prompt then name only the real folder, so no read or command goes through a link. |
| Tests | `src/main/cli/cli.test.ts` | A temporary home folder with `~/.claude-personal/skills → ~/.claude/skills`. The skill is found through the link, and the run's arguments name only the real folder. A path that is already real, or does not exist, is kept as it is. |

## Decisions and alternatives

- **Resolve the skill path instead of allowing the link nodes.** Allowing every symlink between
  the home folder and the skill would also fix the sandbox. But the permission rules would still
  need both spellings, and a link elsewhere on the way would break it again. With one real path,
  the sandbox, the rules and the path the agent is told to use all agree.
- **Skill discovery is unchanged.** The account's own skill still comes first, and Settings still
  shows the path as found. Only the run uses the resolved one.
- **The workspace keeps its spelling.** It is the run's working directory and `CV_HOME`, and
  output paths are shown with it. A workspace opened through a link has not been seen in practice.

## How to test

- `npx vitest run src/main/cli/cli.test.ts`
- By hand: with `~/.claude-personal/skills` a link to `~/.claude/skills`, choose the
  `~/.claude-personal` account in Settings → Agents and tailor a job (attended or unattended).
  The agent reads `SKILL.md` and `build.py` builds the PDFs. Before the fix, it stopped with
  "Operation not permitted".
