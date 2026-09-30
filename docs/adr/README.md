# Architecture Decision Records

An ADR records one architecture decision: the problem, the options that were weighed, the
choice, and what it costs. `docs/changes/<N>-*.md` says what a merged PR changed and why;
an ADR is written *before* the work, for decisions that shape several tickets (a new
process, a new service, a new client) and that would be expensive to reverse.

ADRs are numbered in order of creation and never renumbered. A superseded ADR keeps its file;
its Status line points at the newer one.

## Template

```markdown
# ADR-NNNN: <short title>

Status: Proposed | Accepted | Superseded by ADR-MMMM · Date: YYYY-MM-DD · Issue: #N

## Context
## Decision drivers
## Considered options
## Decision
## Architecture
## Message / event schema
## Security model
## Consequences
## Rollout phases
## Open questions
## References
```

Not every section is needed for a small decision; keep the ones that carry information. Cite
sources (links) for every claim about a third-party product, price or limit, with the date it
was checked.

## Index

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-mobile-remote-control-relay.md) | Mobile remote control through an end-to-end encrypted relay | Proposed | 2026-09-30 |
