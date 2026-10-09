# #70 — Relay: bounded retries for transient Expo push failures

Issue: [silentashish/huntgry#70](https://github.com/silentashish/huntgry/issues/70) · Follow-up from the #35 / PR #59 review · Epic #33

## Context & problem

The relay sent each push once. A single transient failure lost the notification unless another
hint followed: a network error, a 429 or a 503 from Expo, or a `MessageRateExceeded` ticket.
For a "your run needs a reply" push, that can mean the run sits until the owner happens to open
the app.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Classification | `relay/src/push.ts` | `PushOutcome` gains `retry`. Network errors, HTTP 429 and 5xx, and `MessageRateExceeded` tickets are transient; any other 4xx or ticket error stays `failed`. A 429's `Retry-After` (seconds or HTTP date) is read and capped at 1 h (`retryAfterMs`, `MAX_RETRY_AFTER_MS`). A request that takes over 15 s is abandoned as `retry` (`PUSH_TIMEOUT_MS`). |
| Durable retries | `relay/src/room.ts` | New table `push_retries`: device, category, token, text, attempt and next_at. There is at most one row per device and category, so it survives hibernation and restarts. The room's single alarm sends the due ones (`retryPushes`), and `scheduleAlarm` includes `MIN(next_at)`. Each alarm sends at most one retry, so the alarm's other duties never wait on more than one Expo request; the next due one gets its own alarm right after. Due rows are leased for a minute and the alarm is armed for the lease before any request goes out, so a handler cut off mid-request retries a minute later, not never. Each row and its device's token are read again right before its send, so a retry cancelled by an earlier send in the same alarm does not go out. |
| One attempt | `room.ts` `sendPush` | Each attempt ends in one of five ways:<br>• `ok` records the receipt ticket and, after a retry, the coalescing time.<br>• `DeviceNotRegistered` clears the token.<br>• `retry` schedules the next attempt at `max(delay[attempt], Retry-After)` while the budget lasts.<br>• A permanent failure or a spent budget gives up, and that push does not count for coalescing.<br>• A token that changed while the attempt was in flight drops it. |
| Coalescing | `room.ts` `maybePush` | A hint that arrives while a retry is pending replaces that retry's body (newest `pushText` wins) instead of starting a second push. |
| Cancellation | `room.ts` | A new token or `{ pushToken: null }` deletes the retries for the old token, as do `DeviceNotRegistered` (ticket or receipt, via `clearPushToken`) and revocation. |
| Tunable | `relay/src/env.ts` | `PUSH_RETRY_DELAYS_SECONDS` (default `30,120,480`): the waits, whose count is the budget; `""` disables retries. |
| Tests | `relay/test/push-retry.test.ts`, `relay/test/harness.ts`, `relay/test/push.test.ts` | The harness's fake Expo can return an HTTP status (`HttpReply`) or a network error (`NETWORK_ERROR`). The existing coalescing test now uses a permanent ticket error, because a rate-limit error is retried. |

## Decisions and alternatives

- **Budget 3 (30 s, 2 min, 8 min).** These are the issue's numbers. A notification more than
  about 10 minutes late has little value, since the phone fetches state when it opens.
- **One pending retry per device and category, not per hint.** This keeps the "one push per
  category per window" promise: a burst of hints during an Expo outage produces one push, with
  the newest body.
- **The coalescing window starts at delivery.** It starts when a retried push is actually
  accepted, so the window measures what the owner sees.
- **A hint during an in-flight retry that then succeeds is coalesced.** The new body is not
  sent, exactly as for a hint just after any delivered push: the owner was notified for that
  category within the window, and the app fetches the current state when it opens.
- **No retry of the receipts call itself.** It already re-asks one delay later until Expo's
  one-day retention passes.

## How to test

`npm test -w relay` runs 62 tests. The new ones cover:

- a transient failure (`MessageRateExceeded`, network error) followed by success → exactly one
  delivered push;
- a hint during a pending retry → its body is used, with no extra push;
- a 429 with `Retry-After: 2` → the retry waits at least 2 s;
- a 503 every time → 4 sends, then nothing, and the next hint can try again;
- a 400 → no retry;
- cancellation by a new token, by `null`, by revocation, and by `DeviceNotRegistered` on a retry,
  which also clears the token, including a second retry due in the same alarm.

## Follow-ups

- If Expo's outage lasts longer than the budget, the notification is lost. The phone still shows
  the state on open. A "missed while offline" summary on the phone could cover this (#39).
