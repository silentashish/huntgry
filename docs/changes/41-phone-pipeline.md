# #41 — Pipeline control from the phone (desktop side)

Issue: [silentashish/huntgry#41](https://github.com/silentashish/huntgry/issues/41) · Epic #33, E6 · Spec: [ADR-0001](../adr/0001-mobile-remote-control-relay.md) · Builds on #31 (unattended pipeline), #36 (gateway)

## Context & problem

#31 put the unattended pipeline on the desktop: "Run unattended" plans the jobs (pre-flight),
queues them as unattended items under one pipeline record, waits out usage limits, retries,
and leaves every result **Unreviewed**. #36 put the remote gateway on the desktop, but every
`pipeline.*` command still answered `unsupported`, `StatusSummary.pipeline` was always `null`,
and `pipeline.changed` / `pipeline.finished` were never sent.

This change wires the phone to that pipeline, on the desktop only. The phone screens are #38's
app and come later; everything here is tested against fake phones holding real keys, the real
`Pipeline`, `TailorQueue` and `RunManager`, and the fake agent.

The rule from the issue: a pipeline started from the phone is **the same pipeline** the
desktop's "Run unattended" starts (same pre-flight, concurrency cap, spawn gap, retries,
verify gate), and nothing in this ticket can approve, apply or submit.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Gateway | `src/main/remote/gateway.ts` | `pipeline.start` maps the phone's `PipelineStartInput` (`fallback` → `fallbackAgent`, `budget.maxRuns` → `maxJobs`, "Run unattended"'s default options when the phone sends none) onto the desktop's input and runs it through the desktop's own `requirePipelineStartInput` (a refusal is `invalid`), then calls the app's one `Pipeline.start`. `pipeline.pause` / `resume` / `stop` call the same methods as the desktop buttons. Each answers the projected `PipelineState`. A desktop refusal ("A pipeline is already running…", a pre-flight blocker, "No pipeline is running.") reaches the phone as `failed` with the desktop's text, with any path removed. The pipeline names leave the `NOT_YET` list; without a pipeline service (an older wiring, tests) they still answer `unsupported`. `statusOf()` builds the status for `status.get`, `hello` and heartbeats. |
| Workspace binding | `src/main/pipeline/pipeline.ts`, `src/main/pipeline/ipc.ts` | `plan`, `start`, `pause`, `resume` and `stop` take an optional `expected` workspace. With it, another open workspace throws `WorkspaceChangedError` (answered `invalid`) instead of planning, enqueuing or changing that workspace's pipeline; the enqueue itself passes `expected` to the queue. The desktop passes nothing, so its behaviour is unchanged. `pipelineForRemote` is the same instance bound to the checked workspace, next to `queueForRemote`. |
| Projections | `src/main/remote/project.ts` | `projectPipeline`, `projectPipelineSummary`, `projectPipelineStatus`, `projectPipelineCounts`. Statuses: `stopped-budget` → `paused`, `stopping` → `running`, the rest as named. Counts: `done` = built (unreviewed + needs attention + approved + discarded), `unreviewed` = built and waiting for review, plus the optional split below. `eta` = now + `etaMinutes`; `waitingLimitUntil` = the parsed reset + 2 min; `reason` = the stop reason, or the agent's limit message while waiting. `safeText` removes absolute and home paths from desktop text and cuts it to 1 KiB. `StatusSummary.pipeline` is now `{ status, until? }` from the workspace's pipeline. |
| Events | `src/main/remote/events.ts` (new), `src/main/remote/ipc.ts`, `src/main/remote/session.ts` | `RemoteEvents` (Electron-free) turns window events into phone events: `queue.changed`, `run.changed`, `applications.changed` as before, plus `pipeline.changed` (every state the desktop panel gets) and `pipeline.finished`, with a `status` refresh when the pipeline's status or limit changes. Push hints follow what changed (below). `session.broadcast` takes an optional `hint` that overrides `categoryOf` (`null`: no push); nothing else in the session changed. `ipc.ts` only swaps its inline `onEvent` block for `RemoteEvents` and adds the pipeline service. |
| Protocol package | `src/shared/remote/protocol.ts`, `dto.ts` | **Minor, additive.** `PipelineState.counts` (now the named `PipelineCounts`) gains optional `needsAttention`, `needsReply`, `cancelled` and `skipped`, so `pipeline.finished` carries built / needs review / failed / skipped; `PipelineState` gains an optional `reason` (≤ `LIMITS.errorBytes`). The guards accept them and refuse unknown or negative counts; the frame-size row uses every field at its bound. |

### Push hints

One situation is one push. The relay's 5-minute coalescing is a backstop, not the rule, because
a pipeline waiting for a limit emits a state every minute (its ETA moves).

| Event | Hint | When |
| --- | --- | --- |
| `pipeline.changed` | `usage-limit` | The pipeline enters `waiting-limit` with a new reset time (once per pipeline and reset time). `pushText`: the agent's limit message. With a usable fallback agent the pipeline keeps running and nothing is pushed, like the desktop's notification. |
| `pipeline.changed` | `failed` | The pipeline is paused with a reason (spend limit, an agent that cannot start), or a job failed for good (`counts.failed` went up). A user Pause carries none. |
| `pipeline.changed` | `needs-reply` | A job stopped with a question after the nudge (`counts.needsReply` went up). |
| `pipeline.finished` | `pipeline-finished` | Once per summary. `pushText`: "N ready for review · M need a look". |
| `run.changed` of an unattended run | none | A failed turn that is retried, or a turn that ended before the verify gate, is not news; the pipeline reports what is. Attended runs keep #36's hints. |

The first pipeline state after the app starts is a baseline: a limit the phone was already
told about before a restart is not pushed again.

## Decisions and alternatives

- **The desktop's validator, not a second one.** The package guard (`requirePipelineStartInput`
  in `@shared/remote`) checks the wire shape: saved-job-id strings of ≤ 64 characters, enum
  agents, concurrency 1–4, a numeric budget, no unknown field (so no path, flag, model or
  prompt). The gateway then runs the desktop's `requirePipelineStartInput`, which refuses
  anything that is not a job id (`../../master-profile.md`), a cost cap outside $1–$10 000 and
  an agent equal to its fallback. Both refusals are `invalid` and nothing starts.
- **Restart, skip and stall options keep the desktop's defaults** (resume after a restart, skip
  jobs tailored before, 20 minutes). The protocol has no field for them, and they are not
  things to change from a phone.
- **Same rate limit and TTL as #36 decided.** `pipeline.start` shares the once-per-10-s limit
  with `queue.enqueue` per device and is costly (2 h): a start that waited longer while the
  Mac slept is `expired` and never runs.
- **`stopping` shows as `running`, `stopped-budget` as `paused`.** The phone's status set is
  closed (`idle`, `running`, `paused`, `waiting-limit`, `finished`); adding values would break
  older phones. `reason` says why ("Stopped by you.", "Budget reached: …").
- **`pipeline.changed` for `null` is not sent.** A dismissed pipeline has no DTO; the `status`
  refresh that follows says `pipeline: null`.
- **The status is refreshed on status or limit changes only,** not on every ETA tick: the
  status DTO only carries those, and the relay counts every desktop frame (60 a minute).
- **Not done here:** the phone's Pipeline screen and its screenshots (#38's app); a resume
  with a raised budget from the phone (the protocol's `pipeline.resume` takes no arguments;
  raise it on the Mac).

## How to test

```bash
npm test && npm run typecheck && npm run build
```

- `src/main/remote/pipeline.test.ts` (real `Pipeline`, `TailorQueue`, `RunManager`, the gateway
  and `RemoteEvents`, `fixtures/fake-claude.mjs`): a phone start runs the desktop pipeline with
  at most the chosen 2 agent processes, skips an unsaved job, leaves every result Unreviewed
  with Apply blocked, and sends one `pipeline.finished` with built / needs review / failed /
  skipped; the second start within 10 s is `rate-limited`, after that the desktop's "already
  running" message; concurrency 5, a model, flags, notes, a path as job id, an unknown agent,
  a text or too-small budget and agent = fallback are `invalid` and nothing starts; a start
  older than the costly TTL is `expired`; another workspace (by `ws`, or switched after the
  gateway's check) is `invalid` and nothing starts; pause and resume like the buttons (the
  desktop state follows, `pipeline.changed` reaches the phone, no push); **STALL**: stop kills
  both agent processes and cancels the rest (summary `stopped`); **USAGE_LIMIT**:
  `waiting-limit` with `waitingLimitUntil` = reset + 2 min in the event and the status, one
  `usage-limit` push however many states follow, then it resumes by itself; **CRASH**: two
  retries without a push, one `failed` push when the job fails for good.
- `src/main/remote/events.test.ts`: the status and count mapping, paths removed from reasons,
  summary statuses; the start-up baseline, one push per reset time, error pause vs user pause,
  a new pipeline compared with nothing, status refresh only on status or limit changes, and
  unattended `run.changed` never pushing.
- `src/shared/remote/dto.test.ts`, `frame-size.test.ts`: the optional counts and `reason`,
  their refusals, and the largest `pipeline.changed` in one frame.

Manual: not possible yet. It needs a paired phone (#37 pairing, #38 app).

## Follow-ups

- #38: the Pipeline screen (progress, "waiting for usage limit until HH:MM", Pause / Resume /
  Stop, a start sheet from selected jobs) and its screenshots.
- A `pipeline.resume` with a new budget, if the owner wants to raise it from the phone.
