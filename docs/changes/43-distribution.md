# #43 — Distribution: EAS build profiles, Android, TestFlight internal, docs

Issue: [silentashish/huntgry#43](https://github.com/silentashish/huntgry/issues/43) · Epic #33 · Spec: [ADR-0001](../adr/0001-mobile-remote-control-relay.md) ("Rollout phases", "Consequences") · Builds on #38 (the app) and #39 (push, [39-push.md](39-push.md))

## Context & problem

The #38 app builds only from a Mac with a cable (`expo run:ios --device`, 7-day free-Apple-ID
profiles) and nothing describes how to get it onto a phone otherwise. Push (#39) needs the paid
Developer Program, an APNs key and an Expo project. The owner has the Apple Developer Program
but no Expo account yet. This ticket adds the EAS configuration (TestFlight internal for iOS,
an APK or Play internal testing for Android), the app's release identity (icons, versions,
entitlements), and the documentation: the owner's one-time steps, where each secret lives,
and the README section on remote control as a whole.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Build profiles | `mobile/eas.json` | `development` (ad hoc iOS / APK, for installing a branch on registered devices), `preview` (iOS App Store signing → **TestFlight internal**; Android **APK**, internal distribution), `production` (iOS the same; Android **App Bundle** → Play internal testing). `appVersionSource: remote` + `autoIncrement` on preview / production, so build numbers never collide. Each profile names its EAS environment (`development` / `preview` / `production`) for `EAS_PROJECT_ID` and `GOOGLE_SERVICES_JSON`. Node 22.22 like the repo. Submit: Play `internal` track as a draft. Checked with `@expo/eas-json` (the schema eas-cli 24 uses). |
| Identity and versions | `mobile/app.config.ts` | iOS bundle id and Android package `com.huntgry.remote` (still overridable with `HUNTGRY_BUNDLE_ID`). `version` from `mobile/package.json`; `ios.buildNumber` / `android.versionCode` 1 for local builds only (EAS owns them). `runtimeVersion` follows the app version (no OTA updates). `ITSAppUsesNonExemptEncryption: false` answers export compliance. `owner` from `EXPO_OWNER` when set. |
| EAS project id | `mobile/app.config.ts` | `extra.eas.projectId` from `EAS_PROJECT_ID` (shell, EAS environment variable, GitHub variable); no id is committed or invented. Without it the app builds and Settings says push is not available. |
| Push configuration | `mobile/app.config.ts` | The `expo-notifications` plugin: status-bar icon, colour, `aps-environment` `production` for every EAS build (all are distribution-signed) and `development` for local `expo run:ios`; `enableBackgroundRemoteNotifications: false`, so no `UIBackgroundModes` at all. `HUNTGRY_PUSH=0` removes the entitlement for a free Apple ID (a config plugin applied before the plugin list, so its entitlements mod runs after expo-notifications'). Android `googleServicesFile` from `GOOGLE_SERVICES_JSON` (an EAS file variable), never committed. |
| Icons and splash | `mobile/assets/` | The paw from the Figma "Logo" layer (#38's vectors, `src/ui/Logo.tsx`): app icon, adaptive icon and splash re-encoded as palette PNGs (258 → 35 KB, 160 → 21 KB, 76 → 10 KB; libimagequant through sharp, no visible banding); new `notification-icon.png` (96 px white paw on transparent, Android tints it) and `monochrome-icon.png` (Android 13 themed icon), rendered from the same ellipses. |
| Secrets hygiene | `mobile/.gitignore` | `google-services.json`, keystores, service-account keys, `credentials.json`, `.env*` next to the existing `*.p8` / `*.p12` / `*.jks` / `*.mobileprovision`. |
| CI (optional) | `.github/workflows/mobile-build.yml` | Manual dispatch only (platform, profile, submit). A first job checks for the `EXPO_TOKEN` secret and the `EAS_PROJECT_ID` variable and skips with a notice when either is missing; the build job runs `eas-cli@24 build --non-interactive --no-wait` (and `--auto-submit` when asked). The build runs on EAS; signing credentials never reach GitHub. Passes `actionlint`. |
| Release guide | `mobile/RELEASE.md` | Expo account and `eas init` (with the dynamic-config caveat), App Store Connect app record, the APNs key managed by EAS, `eas build --profile preview --platform ios` and `eas submit` to TestFlight internal, Android FCM setup, preview APK, Play internal testing, versions, the three profiles, which secret goes where, the GitHub workflow, free Apple ID builds. |
| READMEs | `README.md`, `mobile/README.md` | Root: **Remote control (phone)** section (deploy the relay, connect the Mac, install, pair, revoke, unpair, rotate, the data-visibility table and the costs, from ADR-0001 and `relay/README.md`). Mobile: push, free Apple ID flag, links to RELEASE.md. |

## Decisions and alternatives

- **TestFlight comes from `preview`, not `production`.** Both use App Store signing, but the
  owner's intent ("internal TestFlight") is the preview channel; `production` is the same build
  for iOS and the Play App Bundle for Android. An Android APK in `preview` installs without a
  Play account.
- **Build numbers on EAS (`appVersionSource: remote`).** Local files cannot know what TestFlight
  already has; EAS increments per build. The alternative, committing a build number per
  release, breaks as soon as a build is retried.
- **Project id from the environment.** `eas init` cannot write into a dynamic `app.config.ts`;
  the id is not secret, but committing a placeholder would break push silently, and committing
  someone's real id is the owner's call. RELEASE.md says hard-coding it is fine.
- **Production APNs for every EAS build.** Ad hoc and App Store provisioning profiles both carry
  `aps-environment: production`; a mismatch fails signing. Only Xcode development signing
  (local `expo run:ios`) uses the sandbox.
- **No `expo-dev-client`.** A development client is another native module and dependency; the
  local `expo run:ios --device` flow from #38 already gives a Metro-connected build. The
  `development` profile is therefore an ad hoc release build, not a dev client.
- **Icons re-encoded, not redrawn.** The #38 PNGs were already rendered from the Figma logo
  vectors; palette encoding cut them by ~85 %. The one-colour paw (notification, monochrome) is
  drawn from the same ellipses, so it matches exactly.
- **The workflow only queues the build** (`--no-wait`): an EAS build takes 15+ minutes and runs on
  Expo's machines; waiting would burn Actions minutes for nothing. It installs with
  `--ignore-scripts` (it only evaluates `app.config.ts`); EAS runs the full `npm ci` itself,
  including the root `postinstall` that downloads Electron.

## How to test

Automated (in this environment):

```sh
cd mobile && npx expo config --type public        # name, version 0.1.0, ios.bundleIdentifier / android.package com.huntgry.remote,
                                                  # buildNumber 1 / versionCode 1, the expo-notifications plugin, monochrome icon
npx expo config --type introspect                 # entitlements: aps-environment development (local)
HUNTGRY_PUSH=0 npx expo config --type introspect  # entitlements: {} (free Apple ID)
EAS_BUILD_PROFILE=preview EAS_PROJECT_ID=<uuid> npx expo config --type introspect
                                                  # aps-environment production, extra.eas.projectId set; no UIBackgroundModes
actionlint .github/workflows/mobile-build.yml
npm test && npm run typecheck && npm run build    # root
npm run export:web -w mobile                      # the web demo still bundles with expo-notifications
```

`eas.json` resolved for every profile and platform with `@expo/eas-json` from eas-cli 24.12.1
(`eas config` itself needs a logged-in account).

Repo scan for credentials: no `.p8`, `.p12`, `.jks`, `.keystore`, `google-services.json`,
service-account JSON, `EXPO_TOKEN` value, admin token or project id is committed (`git ls-files`
and a grep for key headers / token patterns on this branch).

Manual (the owner, see `mobile/RELEASE.md`): create the Expo account, `eas init`, set
`EAS_PROJECT_ID`; `eas build -p ios --profile preview --auto-submit`; add yourself to an
internal TestFlight group; install, pair, background the app and get a push; on Android, set up
FCM, `eas build -p android --profile preview`, install the APK, pair, push.

## Follow-ups

- The owner's account steps (Expo account, `eas init`, APNs key, App Store Connect record,
  Firebase project) and a first TestFlight / APK build with a push round trip; until then
  nothing here has run on EAS.
- After `eas init`, optionally commit the project id and the App Store Connect app id
  (`submit.*.ios.ascAppId`) to skip the prompts.
- "A second person follows the README from zero to a paired phone on a fresh Cloudflare
  account" (#43's test plan) is still to do.
- TestFlight internal builds expire after 90 days: rebuild, or automate with a scheduled run of
  the workflow once it is trusted.
