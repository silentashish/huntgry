# Resume Tailor workspace

This directory is a Resume Tailor workspace created by Huntgry. It is `CV_HOME`
for the `resume-tailor` skill (github.com/silentashish/claude-resume-generator-skill).

- CV_HOME: `{{CV_HOME}}`
- Master profile: `{{MASTER_PROFILE}}` (single source of truth for every tailored resume)
- Base cover letter (optional): `{{COVER_LETTER}}`

When running the skill's `build.py` from this workspace, pass
`--cv-home "{{CV_HOME}}"` (or set `CV_HOME="{{CV_HOME}}"` in the environment) so
generated applications land here as `<role>/<company>/<job-id>/`, not in `~/cv`.

Never overwrite or delete existing application folders; each one is a record of
a submitted application.
