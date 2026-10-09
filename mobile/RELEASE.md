# Releasing Huntgry for iPhone and Android

How to get the phone app (`mobile/`) onto your own iPhone through **TestFlight** (internal
testing) and onto Android as an **APK** or through **Play internal testing**, with push
notifications working, using EAS (Expo Application Services). Issues #39 and #43;
[ADR-0001](../docs/adr/0001-mobile-remote-control-relay.md).

Nothing here is published on the App Store or Play Store. Internal TestFlight builds need no
App Review and expire after **90 days**; rebuild before then.

No credential is ever committed. EAS stores the signing credentials and the push keys; the
repository only holds `eas.json` and `app.config.ts`, which name no account.

## What you need

| Account | Cost | Needed for |
| --- | --- | --- |
| Apple Developer Program | $99 / year (you have it) | TestFlight, the push entitlement, the APNs key |
| Expo account | free | EAS Build / Submit (the free plan includes 15 iOS + 15 Android builds a month) and the Expo push service |
| Firebase project | free | Android push only (FCM) |
| Google Play Console | $25 once | Play internal testing only; a preview APK needs no Play account |

You also need Node 22 (the repo's) and, for the steps that log in, a browser. A Mac is not
required: EAS builds iOS apps on its own Macs.

## 1. Expo account and the EAS project (once)

1. Create an account at <https://expo.dev/signup>.
2. Log in and create the project from the app folder:

   ```sh
   npm install                     # repo root (npm workspaces)
   cd mobile
   npx eas-cli@24 login
   npx eas-cli@24 init             # creates the "huntgry" project under your account
   ```

   `app.config.ts` is dynamic, so `eas init` cannot write the project id into it. It prints the
   id (a UUID) and asks you to add it. Do **not** edit the file; give the id through the
   environment instead:

   ```sh
   export EAS_PROJECT_ID=<the id eas init printed>     # e.g. in ~/.zshrc
   ```

   Every `eas` and `expo` command you run from `mobile/` reads it. The id is not a secret (it
   ends up inside every build); hard-coding it in `app.config.ts` is fine too if you prefer.
   Without it the app still builds, but Settings says push is not available in this build.

3. Give the cloud builds the same id, for all three environments the profiles use:

   ```sh
   npx eas-cli@24 env:set --name EAS_PROJECT_ID --value "$EAS_PROJECT_ID" \
     --environment development --environment preview --environment production --visibility plaintext
   ```

4. Optional: set the first build numbers EAS counts from (they are stored on EAS, see
   [Versions](#versions-and-build-numbers)): `npx eas-cli@24 build:version:set -p ios` (enter 1).

## 2. App Store Connect app record (once)

1. **Bundle id.** <https://developer.apple.com/account/resources/identifiers> → **+** → App IDs →
   App → Bundle ID (explicit) `com.huntgry.remote`, description "Huntgry". Tick **Push
   Notifications**. (Skipping this works too: the first `eas build` registers the id and turns
   on the capabilities the app's entitlements ask for.)
2. **App record.** <https://appstoreconnect.apple.com> → Apps → **+** → New App: platform iOS,
   name "Huntgry" (any free name; it is not shown anywhere public for internal testing),
   primary language, bundle id `com.huntgry.remote`, SKU `huntgry-remote`, full access.
3. Note the app's **Apple ID** (App Information → General Information; a number like
   `6741234567`). `eas submit` asks for it the first time; to skip the question, add it to
   `eas.json` under `submit.preview.ios.ascAppId` and `submit.production.ios.ascAppId`.
4. **Export compliance** is answered in the build: `ITSAppUsesNonExemptEncryption` is `false`
   (the app uses HTTPS/TLS and `tweetnacl` for its own messages only, which is exempt). If App
   Store Connect still asks, answer "None of the algorithms mentioned above".

## 3. The APNs key (once, EAS manages it)

Expo's push service delivers to iPhones with an APNs key from your team. Let EAS create and
keep it:

```sh
cd mobile
npx eas-cli@24 credentials -p ios
# → production → "Push Notifications: Manage your Apple Push Notifications Key"
# → "Set up a Push Key" → let EAS generate a new key (log in with your Apple ID when asked)
```

The first `eas build -p ios` offers the same ("Would you like to set up Push Notifications
for your project?" → Yes). Apple allows two APNs keys per team and one key serves every app of
the team. If you already have a `.p8` key, choose "Use an existing key" and upload it; then
delete the local file (`*.p8` is git-ignored in `mobile/`, but do not keep it in the repo
folder at all).

EAS also generates the distribution certificate and the App Store provisioning profile on the
first build. Check everything with `npx eas-cli@24 credentials -p ios`.

## 4. TestFlight (internal testing)

```sh
cd mobile
npx eas-cli@24 build --profile preview --platform ios      # ~15 min on EAS; prints a link to the build
npx eas-cli@24 submit --profile preview --platform ios --latest
```

or both in one go: `npx eas-cli@24 build -p ios --profile preview --auto-submit`.

The first `eas submit` asks to create an **App Store Connect API key** (let EAS generate it; it
keeps it for later submits). After Apple has processed the build (5–30 minutes):

1. App Store Connect → your app → **TestFlight** → Internal Testing → **+** a group
   ("Owners"), add yourself (your Apple ID must be a user of the team, which the account holder
   is). Builds go to internal testers without Beta App Review.
2. On the iPhone, install **TestFlight** from the App Store, accept the invite, install Huntgry.
3. Pair it with your Mac (Settings → Remote control → Pair a phone). Right after pairing the
   app asks for notification permission; allow it.
4. **Push round trip:** lock the phone (or swipe the app away), then on the Mac let a run wait
   for a reply. One notification "A run needs your reply" arrives; tapping it opens the run.

Every EAS build is signed for distribution, so it uses the production APNs environment
(`aps-environment: production`); only local `npx expo run:ios` builds use the sandbox. Expo's
push service picks the right one for each token.

## 5. Android

### Push on Android (FCM, once)

Expo delivers to Android through Firebase Cloud Messaging. Without this the app works but gets
no push token (Settings says so).

1. <https://console.firebase.google.com> → Add project (Analytics off is fine) → **Add app** →
   Android, package `com.huntgry.remote` → download `google-services.json`.
2. Give it to EAS as a file variable (it is not committed; `google-services.json` is
   git-ignored in `mobile/`):

   ```sh
   cd mobile
   npx eas-cli@24 env:set --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json \
     --environment development --environment preview --environment production --visibility secret
   rm google-services.json
   ```

   `app.config.ts` passes `GOOGLE_SERVICES_JSON` to `android.googleServicesFile`. For a local
   build, point it at a copy outside the repo:
   `GOOGLE_SERVICES_JSON=~/secrets/google-services.json npx expo run:android`.
3. The FCM v1 key Expo sends with: Firebase → Project settings → **Service accounts** →
   Generate new private key (a JSON file). Then
   `npx eas-cli@24 credentials -p android` → production → "Google Service Account" →
   "Manage your Google Service Account Key for Push Notifications (FCM V1)" → upload it, and
   delete the file.

The app creates one notification channel per category (Runs waiting for you, Usage limit,
Pipeline finished, Results to review, Failures), so each can be silenced in Android's settings.

### A preview APK (no Play account)

```sh
cd mobile
npx eas-cli@24 build --profile preview --platform android
```

EAS generates the upload keystore on the first build and keeps it. The build page has a QR /
link to the `.apk`; open it on the phone and allow installing from that source. Updates
install over the previous APK as long as the keystore stays the same (it does: EAS keeps it).

### Play internal testing (optional)

1. Play Console → **Create app** (name "Huntgry", app, free).
2. Build an App Bundle: `npx eas-cli@24 build --profile production --platform android`.
3. Google requires the **first** upload by hand: Play Console → Testing → Internal testing →
   Create release → upload the `.aab` from the build page. Add testers (your Google account).
4. For later uploads with `eas submit`, create a Google service account with access to the
   app (Play Console → Setup → API access, or Google Cloud console → IAM → Service accounts →
   key JSON, then invite it in Play Console → Users and permissions with release rights) and
   upload its key with `npx eas-cli@24 credentials -p android` → "Google Service Account" →
   "Manage your Google Service Account Key for Play Store Submissions". Then:
   `npx eas-cli@24 submit --profile production --platform android --latest` (track `internal`,
   as a draft release you roll out in the console; see `eas.json`).

### Local Android builds

`npx expo run:android` (a device with USB debugging, or an emulator) builds a debug app
without EAS, as in #38.

## Versions and build numbers

- **`version`** (the "1.2.0" users see; `CFBundleShortVersionString` / `versionName`) comes from
  `mobile/package.json`. Bump it by hand for a release.
- **Build numbers** (`CFBundleVersion` / `versionCode`) belong to EAS: `eas.json` has
  `"appVersionSource": "remote"` and `"autoIncrement": true` on `preview` and `production`, so
  every cloud build gets the next number and TestFlight / Play never reject a duplicate.
  `ios.buildNumber` / `android.versionCode` in `app.config.ts` (1) only apply to local
  `expo run:*` builds. See or set them with `npx eas-cli@24 build:version:get` / `:set`.
- `runtimeVersion` follows the app version; the app does not use over-the-air updates.

## Build profiles (`eas.json`)

| Profile | iOS | Android | For |
| --- | --- | --- | --- |
| `development` | Release, ad hoc (internal distribution to devices registered with `eas device:create`) | release APK | Installing a branch on your own devices without TestFlight; for day-to-day JS work `npx expo run:ios --device` with Metro is simpler |
| `preview` | Release, App Store signing, production APNs → **TestFlight internal** | release **APK**, internal distribution | The owner's phones |
| `production` | the same as `preview` | release **App Bundle** → Play internal testing | Play; a store release if one ever happens |

All three install from the repo root with npm (`package-lock.json`). The root `postinstall`
downloads Electron on the build machine, which costs a minute and nothing else.

## Which secret goes where

| What | Where it lives | Notes |
| --- | --- | --- |
| EAS project id | `EAS_PROJECT_ID` in your shell, EAS environment variables, the GitHub variable `EAS_PROJECT_ID` | Not a secret. |
| Apple distribution certificate, provisioning profile | EAS (managed credentials) | Created on the first iOS build. |
| APNs key (`.p8`) | EAS (`eas credentials -p ios`) | Lets Expo's push service reach iPhones. |
| App Store Connect API key | EAS (created by the first `eas submit`) | Uploads to TestFlight. |
| `google-services.json` | EAS file variable `GOOGLE_SERVICES_JSON` | Android push (FCM). |
| FCM v1 service account key | EAS (`eas credentials -p android`) | Lets Expo's push service reach Android phones. |
| Android upload keystore | EAS | Created on the first Android build. Losing it means a new app for Play. |
| Google Play service account key | EAS (`eas credentials -p android`) | Only for `eas submit` to Play. |
| `EXPO_TOKEN` | GitHub Actions secret | An Expo access token (expo.dev → Account settings → Access tokens), for the optional workflow. |
| Relay admin token, owner secret | Cloudflare (`wrangler secret`) and the Mac's encrypted settings | Never on the phone, in EAS or in the repo. |

The phone app contains none of these. The relay sees the phone's Expo push token, never the
APNs or FCM keys; the Mac never sees the push token.

## Building from GitHub Actions (optional)

`.github/workflows/mobile-build.yml` queues an EAS build by hand (Actions → mobile-build → Run
workflow: platform, profile, and whether to submit when done). It does nothing until the repo
has:

- the secret **`EXPO_TOKEN`** (Settings → Secrets and variables → Actions → New repository
  secret), and
- the variable **`EAS_PROJECT_ID`** (same page, Variables tab).

The credentials above stay on EAS; the workflow never sees them. Submitting from the workflow
(`--auto-submit`) needs the App Store Connect API key / Play service account to be on EAS
already, so do the first submit from your computer.

## Free Apple ID builds (no push)

A personal team cannot sign the push entitlement. To build for your own iPhone without the
Developer Program, as in #38:

```sh
HUNTGRY_PUSH=0 npx expo run:ios --device
```

This removes `aps-environment`; the rest of the app works, and Settings says push is not
available (without `EAS_PROJECT_ID`) or that the phone has no push token.
