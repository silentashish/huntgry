# Choose the Claude account runs use

## Problem

One `claude` binary can hold several accounts, each signed in under its own
config folder: `~/.claude` (the default) and, for example, `~/.claude-personal`,
selected with `CLAUDE_CONFIG_DIR` (often by a shell alias or function). Huntgry
never set `CLAUDE_CONFIG_DIR`, so every run, the Settings check, Insights, the
pipeline and the Apply mapper used `~/.claude`, whichever account was signed in
there. The existing CLI picker (#79) chooses a binary, so it could not help.

## Change

- Settings → Claude → **Account** lists every account found: `~/.claude` plus
  each `~/.claude-*` / `~/.claude_*` folder holding a `.claude.json`, each
  labelled with the email and organization `claude auth status` reports for it.
  Pick one, **Choose folder…** for another folder, or **Use default**.
- The choice is saved as `claudeConfigDir` in the app settings and loaded with
  the CLI choices at startup.
- `buildChildEnv` (every Claude child goes through it) sets `CLAUDE_CONFIG_DIR`
  to the chosen folder. Choosing `~/.claude` *unsets* the variable: pointing it
  at `~/.claude` makes Claude read `~/.claude/.claude.json` and another keychain
  entry, and it looks signed out.
- The chosen account's `skills`/`plugins` are searched for the skill first, and
  its `settings.json` gives the preferred model.
- Without a choice, behaviour is unchanged (the app's own environment decides).

## Tests

- `src/main/cli/cli.test.ts` → "Claude account (config folder)".
- `npm run typecheck`, `vitest run` (1519 passed), `e2e/tests/settings.spec.ts` (8 passed).
