# Resume Tailor workspace

This directory is a Resume Tailor workspace created by Huntgry. It is `CV_HOME`
for the `resume-tailor` skill (github.com/silentashish/claude-resume-generator-skill).

- Master profile: `master-profile.md` (single source of truth for every tailored resume)
- Base cover letter (optional): `cover-letter.md`

CV_HOME, the absolute path of this directory, taken literally:

```text
/private/var/folders/bh/ckwhtb817g919ncyknshd8f40000gp/T/huntgry-e2e-N0dt93/workspaces/new-workspace
```

When running the skill's `build.py` from this workspace, pass the path exactly as
quoted below (single quotes, so nothing in it is expanded by the shell), or set
`CV_HOME` in the environment the same way, so generated applications land here as
`<role>/<company>/<job-id>/`, not in `~/cv`:

```sh
--cv-home '/private/var/folders/bh/ckwhtb817g919ncyknshd8f40000gp/T/huntgry-e2e-N0dt93/workspaces/new-workspace'
CV_HOME='/private/var/folders/bh/ckwhtb817g919ncyknshd8f40000gp/T/huntgry-e2e-N0dt93/workspaces/new-workspace'
```

Never overwrite or delete existing application folders; each one is a record of
a submitted application.
