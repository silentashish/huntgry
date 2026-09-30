# Fixture workspaces

Copied into each test's sandbox by `seedWorkspace(name)` (e2e/fixtures/workspace.ts). Every
person, company and posting in here is fictional.

| Name | What it is | The app's status |
| --- | --- | --- |
| `empty-profile` | Exactly what **Create** writes: empty `master-profile.md`, `cover-letter.md`, `CLAUDE.md` | `valid`, empty profile → profile setup |
| `demo` | A filled profile and cover letter, two application folders (`resume.pdf`, `resume_data.json`, `build-report.json`, `huntgry.json`, `job-description.md`) and one saved job under `.huntgry/jobs/` | `valid` → shell |
| `legacy` | The older `master_profile.md` name, no cover letter | `legacy` (importable) |
| `not-a-workspace` | Unrelated files, no master profile | `not-a-workspace` (Import refused, Create after confirmation) |
| `mocks` | The `demo` profile, two saved jobs and six applications whose posting URLs are `http://mock-server.invalid/…`: Lever, Greenhouse and generic (with `cover.pdf`) forms, one without `resume.pdf`, one already applied, one redirecting to another origin. The Jobs, Browser and Apply specs use it. | `valid` → shell |

`mocks` is seeded through `e2e/fixtures/servers/fixture.ts`, which rewrites every `http://mock-server.invalid` in its
`.json` and `.md` files to the per-run mock server (`http://127.0.0.1:<port>`) before the app launches.

`CLAUDE.md` in `empty-profile` carries the path of the folder it was created in, which does not matter to any test
(Import never reads it). The binary `resume.pdf` files and the sample resumes under `../resumes/` are produced by
`node e2e/fixtures/generate.mts`; edit that script rather than the binaries.
