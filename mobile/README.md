# Huntgry for iPhone (and Android)

The phone side of remote control ([ADR-0001](../docs/adr/0001-mobile-remote-control-relay.md),
#38): an Expo SDK 57 app that pairs with Huntgry on your Mac by QR and then watches and steers
it through your own end-to-end encrypted relay. Status, the queue, a run's transcript with a
reply box, notification settings, the unattended pipeline (#41), saved jobs and application
files (#40) and the review of unattended results (#42). Nothing on the phone can submit or
apply an application, run a command line or change a desktop setting, and it approves only
what it was shown (see [Review](#review-from-the-phone)).

Workspace package `@huntgry/mobile`. It depends on `@huntgry/remote-protocol` (the wire
contract in `src/shared/remote/`) like the relay does; the root `package.json` lists no Expo or
React Native package (`src/main/remote/deps.test.ts`).

## Layout

| Path | What |
| --- | --- |
| `index.ts` | Entry: `react-native-get-random-values` first (Hermes has no `crypto.getRandomValues`, tweetnacl needs it), then `expo-router/entry`. |
| `src/remote/` | The client, plain TypeScript and unit-tested in Node: `relay.ts` (socket, first-frame auth, boxing, `seq`, acks, dedupe, reconnect), `pairing.ts`, `commands.ts`, `vault.ts` (what the secure store keeps), `model.ts` (the state the screens render), `files.ts` (`file.get` chunk reassembly and SHA-256 check), `review.ts` (revision-bound decision rules), `pipeline.ts` (the start sheet's input). |
| `src/app/` | expo-router routes: `pair`, `(tabs)/index` (Status), `queue`, `run/[id]`, `pipeline`, `review`, `result?app=`, `files?app=`, `jobs`, `settings`. |
| `src/screens/` | The screens, built from the Figma file's mobile page. |
| `src/ui/` | Scent Trail tokens (`theme.ts`), text styles, cards, badges, buttons, toggle, tab bar, icons (Tabler), animations. |
| `src/state/` | The model provider, the native adapters (expo-secure-store, WebSocket, expo-device), `share.ts` (expo-file-system + expo-sharing for the OS viewer) and the demo data. |

## Run it on your iPhone

You need a Mac with Xcode (16 or later) and an Apple ID. A **free** Apple ID works: Xcode signs
the app with a personal team and the build runs for 7 days. Push notifications need the paid
Apple Developer Program and come with #39.

```sh
npm install                          # at the repo root (npm workspaces)
cd mobile
npx expo run:ios --device            # pick your iPhone (USB or the same Wi-Fi)
```

The first run generates `mobile/ios/` (not committed: continuous native generation), installs
the pods, builds and installs the app.

- **Signing.** If Xcode says the bundle id is taken or needs a team, open
  `mobile/ios/Huntgry.xcworkspace`, select the Huntgry target → Signing & Capabilities, tick
  "Automatically manage signing" and choose your (personal) team. Or use your own bundle id:
  `HUNTGRY_BUNDLE_ID=com.yourname.huntgry npx expo run:ios --device` (it is read in
  `app.config.ts`; the default is `com.huntgry.remote`).
- **Trust the developer.** On the phone: Settings → General → VPN & Device Management → your
  Apple ID → Trust. Developer Mode must be on (Settings → Privacy & Security).
- **Release build** (no Metro needed, faster): `npx expo run:ios --device --configuration Release`.
- **After pulling native dependencies** (`expo-file-system` and `expo-sharing` came with #40),
  run `npx expo run:ios --device` again: a build from before does not contain them.

### Android

```sh
cd mobile
npx expo run:android                 # a device with USB debugging, or an emulator
```

## Pair it with your Mac

1. On the Mac: Settings → Remote control → **Pair a phone**. A QR is shown for 2 minutes.
2. On the phone: **Scan to pair** (camera permission is asked once), or open the QR's
   `huntgry://pair?…` link, or **Paste a code instead**.
3. Approve "Pair '<your phone>'?" on the Mac. The phone stores its keys and connects.

The relay URL in the QR must be `https://`; anything else is refused before connecting.

## What the screens do

- **Pipeline** (Home card → Pipeline, also from Queue): progress, the usage-limit wait with its
  reset time, why it paused, Pause / Resume / Stop (Stop asks for a second tap), the finished
  summary. Start one from **Jobs**: tick saved jobs → **Run N unattended…** → agent, fallback,
  1–4 at a time, an optional budget. It is the desktop's "Run unattended": same pre-flight,
  results stay Unreviewed.
- **Jobs**: your saved jobs, 50 at a time, dismissed ones flagged; search; **Add a job by URL**
  (http(s) public links only, checked on the phone and again on the Mac); **Queue N selected**.
- **Review**: the Unreviewed results. A result shows its previews, reframings to tick one by
  one, open gaps, notes and the verify report. **Approve** unlocks once page 1 of each document
  has loaded and matched the hash the Mac listed for that revision. **Re-run with answers**
  goes to the same run. **Discard** archives (files are kept). If the result changed on the
  Mac (`stale`), or the Mac no longer knows what this phone was shown (`denied`, for example
  after a restart), the phone reloads it and asks you to check again; it does not unpair.
  When part of a result did not fit on the phone it says "approve on the Mac".
- **Files** (from a result): the PDFs and every page preview, each fetched in 24 KiB pieces,
  reassembled and kept only if its SHA-256 matches. **Open** hands the PDF to iOS (Quick Look,
  Files, Mail…) or Android.

### Review from the phone

The phone sends back exactly the `revision` it was served and the ids of the reframings it
showed and you ticked, never their text. The Mac rebuilds the result from disk and refuses
anything else. Every approval is in the Mac's audit log with the revision and the ids.

## Demo mode (no Mac, no relay)

`EXPO_PUBLIC_DEMO=1` runs every screen on the sample data of the Figma file; commands are
answered by a pretend Mac and nothing is stored.

```sh
npm run demo:web -w mobile           # expo start --web with the demo data
npm run export:web -w mobile         # static web build in mobile/dist
```

On the web, `?demo=offline`, `?demo=unpaired`, `?demo=waiting`, `?demo=denied` and
`?demo=again` show the other states (for example `http://localhost:8081/?demo=offline`);
`?demo=limit` shows the pipeline waiting for a usage limit and `?demo=idle` no pipeline. The
demo's jobs, results and files are answered through the model's own handlers, so file
reassembly, the hash check and the approval rules run as with a Mac. The screenshots in
`docs/changes/assets/38-*.png` and `phone-*.png` were taken this way at 390 × 844.

The web build is for development and screenshots only: the browser has no secure store, so a
real pairing there would live in memory.

## Tests and type check

```sh
npm test -w mobile                   # vitest: relay client, pairing, commands, model, files, review, pipeline, formatters
npm run typecheck -w mobile          # tsc, strict
```

Both also run from the root `npm test` and `npm run typecheck`.

## What the phone stores

In the iOS keychain / Android Keystore (`expo-secure-store`, this device only, readable after
first unlock): its keypair, the pairing (device id, relay token, desktop public key, derived
session key, sid, relay URL, room, the names and the chosen notification categories), its
outgoing `seq` and the desktop's `lastSeq`, and the last `StatusSummary`. Transcripts, the
queue, jobs, review results and application files are kept in memory only. A file you
**Open** is written to the app's cache for the OS viewer and deleted when the app comes back
to the foreground or starts. Unpair, a revoke on the Mac (`device.revoked` or
relay close 4001) and a "pair again" answer delete all of it.

## Monorepo notes

- The root uses React 19.3 for the desktop renderer; React Native 0.86 needs exactly 19.2.x.
  npm installs that copy in `mobile/node_modules`, `metro.config.js` resolves every `react` /
  `react-dom` import from there (hoisted packages included), and `tsconfig.json` maps the
  types the same way. `expo-doctor` reports the two copies; that is expected.
- `expo-doctor` also flags the two lockfiles (the repo keeps npm and pnpm in sync on purpose).
