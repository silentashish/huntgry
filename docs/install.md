# Installing Huntgry

Huntgry is a desktop app. Each release on
[GitHub Releases](https://github.com/silentashish/huntgry/releases) has installable builds, so you
do not need to clone the repository or build it yourself. macOS is the primary target. The Linux
build is packaged the same way but gets less testing. The Windows build is **experimental**: it
installs and opens, but it cannot tailor resumes yet (see [Windows](#windows)).

- [Download](#download)
- [macOS](#macos)
- [Windows](#windows)
- [Linux](#linux)
- [Verifying the download](#verifying-the-download)
- [First launch: what Huntgry needs](#first-launch-what-huntgry-needs)
- [Updating](#updating)
- [Cutting a release](#cutting-a-release)

## Download

Open the [latest release](https://github.com/silentashish/huntgry/releases/latest) and download the
file for your computer (`<version>` is the release number, e.g. `0.2.0`):

| Computer | File |
| --- | --- |
| Mac with Apple silicon (M1 or later) | `Huntgry-<version>-mac-arm64.dmg` |
| Mac with an Intel processor | `Huntgry-<version>-mac-x64.dmg` |
| Windows 10 or 11 (64-bit) | `Huntgry-<version>-win-x64.exe` |
| Linux (x86-64) | `Huntgry-<version>-linux-x86_64.AppImage` |

The `.zip` files hold the same macOS app as the `.dmg` files. `SHA256SUMS.txt` lists the checksum of
every file; see [Verifying the download](#verifying-the-download).

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip Apple M…" is Apple silicon,
"Processor Intel…" is Intel.

## macOS

Huntgry is not yet signed with an Apple Developer ID or notarized by Apple (that comes with [#168](https://github.com/silentashish/huntgry/issues/168)), so
macOS blocks the first launch. You allow it once; after that it opens normally.

1. Open the `.dmg` and drag **Huntgry** onto the **Applications** folder.
2. Open **Huntgry** from Applications. macOS refuses with a dialog:

   > **“Huntgry” Not Opened**
   >
   > Apple could not verify “Huntgry” is free of malware that may harm your Mac or compromise your
   > privacy.

   with the buttons **Done** and **Move to Trash**. Click **Done**.
3. Open **System Settings → Privacy & Security** and scroll down to **Security**. It reads:

   > “Huntgry” was blocked to protect your Mac.

   Click **Open Anyway** next to it.
4. macOS asks again, this time with an **Open Anyway** button:

   > **Open “Huntgry”?**
   >
   > Apple is not able to verify that it is free from malware that could harm your Mac or compromise
   > your privacy. Don’t open this unless you are certain it is from a trustworthy source.

   Click **Open Anyway** and confirm with Touch ID or your login password. Huntgry starts, and later
   launches no longer ask.

The **Open Anyway** button stays in Privacy & Security for about an hour after the blocked launch; if
it is gone, open Huntgry once more and go back to step 3. On macOS 14 and earlier you can instead
Control-click Huntgry in Applications, choose **Open**, then **Open** in the dialog.

Do not remove the quarantine flag with `xattr` to skip these steps: the check above is what tells you
the copy you run is the one you downloaded and verified.

### “Huntgry is damaged and can’t be opened”

This message means the app's signature does not match its files, which is not something
**Open Anyway** can fix. Download the `.dmg` again, [verify its checksum](#verifying-the-download)
and drag a fresh copy into Applications. If it persists, please
[open an issue](https://github.com/silentashish/huntgry/issues).

## Windows

1. Run `Huntgry-<version>-win-x64.exe`.
2. The installer is not code-signed, so Microsoft Defender SmartScreen shows **Windows protected your
   PC** ("Microsoft Defender SmartScreen prevented an unrecognized app from starting…"). Click
   **More info**, check that the app is `Huntgry-<version>-win-x64.exe`, then click **Run anyway**.
3. The installer installs Huntgry for your user (no administrator rights) and adds it to the Start
   menu.

**Known limitation: Windows cannot tailor resumes yet.** Huntgry's discovery of the agent CLIs,
Python and LaTeX only knows macOS and Linux paths. On Windows it does not find `claude.exe` or npm's
`codex.cmd`, does not find Python, and cannot create or use the Python environment
(**Install Python dependencies** reports that `python3` was not found). Settings therefore never
reaches "Ready to tailor". The board, jobs, Explore, the browser and the master profile work. Windows
support is tracked in [#175](https://github.com/silentashish/huntgry/issues/175); until then, use
the macOS or Linux build to tailor.

## Linux

The AppImage is a single file that runs without installing:

```bash
chmod +x Huntgry-<version>-linux-x86_64.AppImage
./Huntgry-<version>-linux-x86_64.AppImage
```

AppImages need FUSE 2. On Ubuntu 22.04 and later, install it with `sudo apt install libfuse2` (on
Ubuntu 24.04: `libfuse2t64`) if the AppImage does not start.

## Verifying the download

Each release has `SHA256SUMS.txt`, one line per file: the SHA-256 checksum, two spaces, the file
name. Download it into the same folder as the file you downloaded, then:

macOS and Linux (in Terminal, in that folder):

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
# Huntgry-0.2.0-mac-arm64.dmg: OK
```

`--ignore-missing` skips the files you did not download. On Linux, `sha256sum -c SHA256SUMS.txt
--ignore-missing` works the same way.

Windows (PowerShell, in that folder):

```powershell
(Get-FileHash .\Huntgry-0.2.0-win-x64.exe -Algorithm SHA256).Hash
Select-String "Huntgry-0.2.0-win-x64.exe" .\SHA256SUMS.txt
```

The two values must be the same (PowerShell prints the hash in capitals; the comparison is not
case-sensitive). Anything else means the file is incomplete or not the one released: do not run it.

## First launch: what Huntgry needs

Huntgry asks for a **workspace** first: a folder for your master profile and applications (create a
new one or import an existing one). Everything else is under **Settings**, which checks what is
installed and offers to install what is missing:

| What | Why | How Huntgry helps |
| --- | --- | --- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (or Codex, or Antigravity) | the agent that tailors the resume | **Install Claude Code** runs Anthropic's official installer (`claude.ai/install.sh`, into `~/.local/bin`); **Update Claude Code** updates an older one. Sign in once in a terminal: `claude auth login`. Codex and Antigravity are found if installed; you install them yourself. |
| The [resume-tailor skill](https://github.com/silentashish/claude-resume-generator-skill) | the instructions and scripts the agent follows | **Install resume-tailor** downloads the latest release from GitHub into `~/.claude/skills/resume-tailor`; **Sync from GitHub** updates it; **Install skill** links it for Codex and Antigravity. |
| Python 3 and the modules `pydantic`, `jinja2`, `pymupdf` (`python-docx` optional) | the skill's build and checks | **Install Python dependencies** creates a virtual environment in Huntgry's app data folder and installs them there; your system Python stays untouched. Python 3 itself must be installed (on macOS: `xcode-select --install` or [python.org](https://www.python.org/downloads/)). |
| A LaTeX distribution (`pdflatex`) | building the PDF | Not installed by Huntgry. Settings → **Installing LaTeX and poppler** shows the commands: [TinyTeX](https://yihui.org/tinytex/) into your home folder (no admin rights), or BasicTeX/MacTeX. |
| poppler (`pdftotext`, `pdftoppm`) | checking the PDF | Not installed by Huntgry: `brew install poppler` on macOS, `sudo apt install poppler-utils` on Debian/Ubuntu. |

Huntgry finds these tools in the usual install folders (`~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, TinyTeX and MacTeX folders) and in the `PATH` your login shell sets up, so tools
installed through `nvm`, `asdf` or `brew shellenv` are found even though an app opened from the Dock
or Finder starts with a minimal `PATH`.

The app's own data (settings, the Python environment, remembered answers, review decisions) lives in
`~/Library/Application Support/Huntgry` on macOS, `%APPDATA%\Huntgry` on Windows and
`~/.config/Huntgry` on Linux. Your workspace stays where you put it.

## Updating

Huntgry does not update itself yet ([#168](https://github.com/silentashish/huntgry/issues/168)). Settings → **About** shows the installed version and links
to its release notes. To update, download the new release and install it over the old one (on macOS,
drag it into Applications and choose **Replace**). Your workspace and settings are kept. A new macOS
build is a new unsigned app, so macOS asks for **Open Anyway** once more.

## Cutting a release

For maintainers. Releases are built by `.github/workflows/release.yml` from a `v*` tag; the version
comes from the tag, which must match `package.json` (the workflow fails with "Tag vX does not match
package.json version Y" otherwise).

1. On an up-to-date `main` with a clean tree, bump the version. `npm version` updates `package.json`
   and `package-lock.json`, commits them and creates the tag `v<version>`:

   ```bash
   git switch main && git pull
   npm version 0.2.0 -m "chore(release): %s"   # or: npm version minor / patch / prerelease --preid beta
   ```

2. Push the commit and the tag. The tag starts the workflow:

   ```bash
   git push --follow-tags
   ```

   If `main` is protected, push the bump through a PR first (`npm version 0.2.0 --no-git-tag-version`,
   merge it), then tag the merge commit: `git tag v0.2.0 <sha> && git push origin v0.2.0`.
3. The workflow builds macOS (arm64 and x64), Windows and Linux in parallel, writes
   `SHA256SUMS.txt` and creates a **draft** release with notes generated from the PRs merged since
   the previous tag. A version with a suffix (`0.2.0-beta.1`) is marked as a pre-release.
4. Open the draft from the run's summary (or the [Releases](https://github.com/silentashish/huntgry/releases)
   page), edit the notes if needed, download the macOS build for your Mac and check it opens and
   reports the right version in Settings → About.
5. Click **Publish release**. Nothing is public until then.

If a run fails (a flaky runner, an upload cut off), rerun it from the Actions page. A draft that
already exists for the tag gets the rerun's complete set of files and keeps its notes; a release that
is already published is never changed, and the run says so.

To throw a draft away (for example a failed or test run), delete the release and its tag:
`gh release delete v0.2.0 --yes --cleanup-tag`.

To dry-run the workflow without touching `main`, tag a throwaway commit whose `package.json` has a
test version, push only the tag, then delete both. This is how the workflow was tested for #167:

```bash
git worktree add --detach /tmp/release-dry-run HEAD && cd /tmp/release-dry-run
npm version 0.0.0-test.1 --no-git-tag-version --ignore-scripts
git commit -qam "chore(release): throwaway 0.0.0-test.1" && git tag v0.0.0-test.1
git push origin refs/tags/v0.0.0-test.1          # the run creates a draft pre-release
gh release delete v0.0.0-test.1 --yes --cleanup-tag
```
