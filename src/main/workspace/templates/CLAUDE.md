# Resume Tailor workspace

This directory is a Resume Tailor workspace created by Huntgry. It is `CV_HOME`
for the `resume-tailor` skill (github.com/silentashish/claude-resume-generator-skill).

- Master profile: `{{MASTER_PROFILE}}` (single source of truth for every tailored resume)
- Base cover letter (optional): `{{COVER_LETTER}}`

CV_HOME, the absolute path of this directory, taken literally:

```text
{{CV_HOME}}
```

When running the skill's `build.py` from this workspace, pass the path exactly as
quoted below (single quotes, so nothing in it is expanded by the shell), or set
`CV_HOME` in the environment the same way, so generated applications land here as
`<role>/<company>/<job-id>/`, not in `~/cv`:

```sh
--cv-home {{CV_HOME_SHELL}}
CV_HOME={{CV_HOME_SHELL}}
```

Never overwrite or delete existing application folders; each one is a record of
a submitted application.
