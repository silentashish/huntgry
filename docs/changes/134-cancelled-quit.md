# #134 — An unattended pipeline queued its jobs and never started one

Issue: [silentashish/huntgry#134](https://github.com/silentashish/huntgry/issues/134)

## Context & problem

Jobs selected on the Jobs page and sent to the unattended pipeline stayed **Queued** forever.
The pipeline card said Running, but no run started. The queue file showed nothing wrong: every
item `queued`, no attempts, no retry wait, no error, the pipeline `running` with no limit. A
restart fixed it, so the fault was in the running app's memory.

The cause was a quit that did not happen. On Cmd+Q, `before-quit` stopped the pipeline, the
queue, the runs and the remote session, then quit again. A window can still refuse that second
quit: the master profile editor asks "Keep Editing?" when it has unsaved edits. When it did, the
app kept running with every one of those services stopped for good:

- `TailorQueue.shutdown()` sets `stopped`, and nothing cleared it. Every `pump()` returned at
  once, so no job was ever launched.
- `Pipeline.shutdown()` stops the 60 s tick and its `changed()` broadcasts.
- `pipeline.start()` and `queue.enqueue()` did not check `stopped`. They saved the record and
  the items, so the Tailor page showed a Running pipeline with every job Queued.

The job tabs and the apply session were also closed in `before-quit`, so the Browser page was
broken after a cancelled quit too.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Quit | `src/main/index.ts` | The shutdown moves from `before-quit` to `will-quit`. Electron sends `will-quit` only once every window has closed, so the quit can no longer be cancelled. The window closing has already closed its tabs (`BrowserManager` closes them on the window's `closed`), so an apply session's page is gone before `stopApply()` too. The runs are still stopped and saved before the second quit goes through, as before. |
| Queue | `src/main/queue/queue.ts` | `enqueue` throws "Huntgry is quitting…" once the queue is shut down, instead of queuing jobs nothing will start. |
| Pipeline | `src/main/pipeline/pipeline.ts` | `start` throws the same way once the pipeline is shut down: no record, no jobs. |
| Tests | `e2e/tests/pipeline-unattended.spec.ts`, `src/main/queue/queue.test.ts`, `src/main/pipeline/pipeline.test.ts` | End to end with the scripted agents: selecting jobs, **Run unattended** and starting the pipeline starts runs: 3 jobs, 8 jobs at 2 at a time, a second pipeline after a stopped one, two Tailor-page runs holding both slots, a workspace with a finished pipeline, and **after a quit that a window refused**, which failed before this change. Unit tests cover the two refusals. |

## Decisions and alternatives

- **`will-quit` instead of undoing the shutdown on a cancelled quit.** Electron does not report a
  cancelled quit, and by then the runs would already be stopped: answering "Keep Editing" would
  have cost the user every run in progress.
- **The refusals are a backstop.** With the quit fixed, nothing should call `start` or `enqueue`
  after shutdown. If something does, the user now sees an error instead of a pipeline that never moves.

## How to test

- `npx vitest run src/main/queue src/main/pipeline`
- `npm run build && npx playwright test -c e2e/playwright.config.ts e2e/tests/pipeline-unattended.spec.ts`
- By hand: open the master profile editor, change a field, press Cmd+Q and choose **Keep
  Editing**. Then select jobs on the Jobs page, **Run unattended** and start: the first two jobs start.
