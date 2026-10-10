# Huntgry for iPhone (and Android)

The phone side of remote control ([ADR-0001](../docs/adr/0001-mobile-remote-control-relay.md),
#38): an Expo SDK 57 app that pairs with Huntgry on your Mac by QR and then watches and steers
it through your own end-to-end encrypted relay. Status, the queue, a run's transcript with a
reply box, and notification settings. Nothing on the phone can submit an application, run a
command line or change a desktop setting.

Workspace package `@huntgry/mobile`. It depends on `@huntgry/remote-protocol` (the wire
contract in `src/shared/remote/`) like the relay does; the root `package.json` lists no Expo or
React Native package (`src/main/remote/deps.test.ts`).

## Layout

| Path | What |
| --- | --- |
| `index.ts` | Entry: `react-native-get-random-values` first (Hermes has no `crypto.getRandomValues`, tweetnacl needs it), then `expo-router/entry`. |
| `src/remote/` | The client, plain TypeScript and unit-tested in Node: `relay.ts` (socket, first-frame auth, boxing, `seq`, acks, dedupe, reconnect), `pairing.ts`, `commands.ts`, `vault.ts` (what the secure store keeps), `model.ts` (the state the screens render). |
| `src/app/` | expo-router routes: `pair`, `(tabs)/index` (Status), `queue`, `run/[id]`, `review`, `jobs`, `settings`. |
| `src/screens/` | The screens, built from the Figma file's mobile page. |
| `src/ui/` | Scent Trail tokens (`theme.ts`), text styles, cards, badges, buttons, toggle, tab bar, icons (Tabler), animations. |
| `src/state/` | The model provider, the native adapters (expo-secure-store, WebSocket, expo-device) and the demo data. |

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

## Demo mode (no Mac, no relay)

`EXPO_PUBLIC_DEMO=1` runs every screen on the sample data of the Figma file; commands are
answered by a pretend Mac and nothing is stored.

```sh
npm run demo:web -w mobile           # expo start --web with the demo data
npm run export:web -w mobile         # static web build in mobile/dist
```

On the web, `?demo=offline`, `?demo=unpaired`, `?demo=waiting`, `?demo=denied` and
`?demo=again` show the other states (for example `http://localhost:8081/?demo=offline`). The
screenshots in `docs/changes/assets/38-*.png` were taken this way at 390 × 844.

The web build is for development and screenshots only: the browser has no secure store, so a
real pairing there would live in memory.

## Tests and type check

```sh
npm test -w mobile                   # vitest: relay client, pairing, commands, model, formatters
npm run typecheck -w mobile          # tsc, strict
```

Both also run from the root `npm test` and `npm run typecheck`.

## What the phone stores

In the iOS keychain / Android Keystore (`expo-secure-store`, this device only, readable after
first unlock): its keypair, the pairing (device id, relay token, desktop public key, derived
session key, sid, relay URL, room, the names and the chosen notification categories), its
outgoing `seq` and the desktop's `lastSeq`, and the last `StatusSummary`. Transcripts, the
queue and results are kept in memory only. Unpair, a revoke on the Mac (`device.revoked` or
relay close 4001) and a "pair again" answer delete all of it.

## Monorepo notes

- The root uses React 19.3 for the desktop renderer; React Native 0.86 needs exactly 19.2.x.
  npm installs that copy in `mobile/node_modules`, `metro.config.js` resolves every `react` /
  `react-dom` import from there (hoisted packages included), and `tsconfig.json` maps the
  types the same way. `expo-doctor` reports the two copies; that is expected.
- `expo-doctor` also flags the two lockfiles (the repo keeps npm and pnpm in sync on purpose).
