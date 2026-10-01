# Fixture workspaces

Copied into each test's sandbox by `seedWorkspace(name)` (e2e/fixtures/workspace.ts). Every
person, company and posting in here is fictional.

| Name | What it is | The app's status |
| --- | --- | --- |
| `empty-profile` | Exactly what **Create** writes: empty `master-profile.md`, `cover-letter.md`, `CLAUDE.md` | `valid`, empty profile → profile setup |
| `demo` | A filled profile (with a `## Volunteering` section the editor does not know) and cover letter, five application folders across statuses and one saved job under `.huntgry/jobs/` (see below) | `valid` → shell |
| `legacy` | The older `master_profile.md` name, no cover letter | `legacy` (importable) |
| `not-a-workspace` | Unrelated files, no master profile | `not-a-workspace` (Import refused, Create after confirmation) |

## `demo` applications

Alex Rivera's profile lists Go, Python, TypeScript, SQL, AWS, Terraform, Docker, PostgreSQL (plus Django, Redis and Rust
through entries) and states "No Kubernetes in production yet" under Gaps and constraints. The job descriptions ask for
skills the profile has and skills it lacks, so the insights card and the graph overlay have gaps to show:

| Folder | Status | Files | Job description asks for | Why it is there |
| --- | --- | --- | --- | --- |
| `software-engineer/acme/acme-4821` | `generated` | `resume.pdf`, `resume_data.json`, `build-report.json` (ok) | Go, PostgreSQL, AWS (all present) | The plain case; Apply is possible (resume + posting URL) |
| `backend-engineer/globex/gx-77` | `applied` on 2026-09-20, `source: manual` | `resume.pdf`, `resume_data.json`, `build-report.json` (**failed** `one_page`, 1 style warning) | Python (present) | Failed build badge; `jobUrl` in `huntgry.json` |
| `platform-engineer/initech/init-9` | `interviewing`, `source: hiring.cafe` | `resume.pdf`, `cover.pdf`, `resume-page-1.jpg`, `cover-page-1.jpg`, `cover_data.json`, `build-report.json` (ok) | Kubernetes (noted gap), **Kafka** (gap), Terraform (present) | Page previews served over `huntgry-file://`, cover letter tab |
| `data-engineer/umbrella/umb-12` | `generated` | `job-description.md`, `resume_data.json` only | **Kafka**, **Spark**, Airflow (gaps), Python, SQL | No `resume.pdf`: Apply is blocked with that reason; no build report |
| `frontend-engineer/wayne/wy-3` | `rejected`, applied 2026-09-10, `source: indeed` | `resume.pdf`, `resume_data.json`, `build-report.json` (ok, 1 soft warning) | **React**, **GraphQL** (gaps), TypeScript | No posting URL anywhere: Apply is blocked with that reason |

The saved job `.huntgry/jobs/hiring.cafe-demo-1.json` (Initech, Staff Backend Engineer) asks for Go, PostgreSQL and
Kubernetes; its URL differs from every application's, so it counts as a sixth job description. Expected gaps, most
asked first: Kafka (2 jobs), then Airflow, GraphQL, React, Spark (1 each); Kubernetes is "noted" (already in Gaps and
constraints) and never offered.

`CLAUDE.md` in `empty-profile` carries the path of the folder it was created in, which does not matter to any test
(Import never reads it). The binary `resume.pdf` / `cover.pdf` files, the `*-page-1.jpg` previews (a 246-byte grayscale baseline JPEG built by
`buildJpeg` in the script, no encoder dependency) and the sample resumes under `../resumes/` are produced by
`node e2e/fixtures/generate.mts`; edit that script rather than the binaries. To add an application to `demo`, create
`<role>/<company>/<job-id>/` with at least one of the marker files (`job-description.md`, `resume_data.json`,
`build-report.json`, `resume.pdf`, `cover_data.json`), write text files by hand and add a `write(...)` line to the
script for any binary; keep the table above in step, since the specs assert the counts and gaps it lists.
