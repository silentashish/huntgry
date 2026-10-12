# #132 — README refresh: logo, screenshots, Buy me a coffee

Issue: [silentashish/huntgry#132](https://github.com/silentashish/huntgry/issues/132)

## Context

The README opened with a plain `# Huntgry` heading and went straight into the architecture sketch: no logo, no
picture of the app, no way to support the project.

## What changed

| Area | Files | What |
| --- | --- | --- |
| Logo | `docs/assets/logo.svg` | The paw brand mark as a standalone SVG. |
| Screenshots | `docs/assets/screenshots/{dashboard,board,tailor,apply}.png`, `e2e/screenshots/readme.spec.ts`, `e2e/screenshots.config.ts`, `package.json` (`screenshots`) | Real screenshots of the built app, and the script that takes them. |
| README | `README.md` | Centred hero (logo, title, tagline, e2e/ci badges, Buy me a coffee badge, Dashboard shot), "What it does", Screenshots, Contents, then every existing section unchanged in content and order, then "Support". |
| Link check | `scripts/check-doc-links.mjs`, `package.json` (`check:docs`, run by `npm test`) | Checks every relative link, image and `#anchor` of a Markdown file, and that every linked `.svg` is well-formed XML. |

## Decisions

- **Logo source**: `src/renderer/src/components/ui/PawLogo.tsx` (Figma "Logo / Paw" `22:592`), geometry copied
  as is, with the CSS variables resolved from `src/renderer/src/theme/tokens.css`: `--hg-ember-300` `#ffc46b`,
  `--hg-ember-600` `#e66e0a`, `--hg-ink-950` `#07090d`. The mark is an opaque gradient tile with a dark paw, so it
  needs no light/dark variants on GitHub. The SVG must stay well-formed XML: an earlier version named the tokens
  in an XML comment, and the `--` in them (forbidden inside XML comments) made browsers drop the image, so the
  README showed no logo. `npm run check:docs` now parses every linked SVG with jsdom's XML parser. `resources/icon.svg` is the old magnifier app icon and is untouched
  (changing the app icon is out of scope). No PNG: GitHub renders the SVG through `<img>`.
- **Screenshots** are taken from the built app through the e2e harness, not mocked up: the sandbox (own
  `userData`, `HOME`, `PATH`), the fictional `demo` workspace (Alex Rivera, Acme, Globex, Initech…), the fake
  `claude` for the Tailor run, and the mock ATS on `127.0.0.1` for Apply. No real personal data can reach them.
  Window 1440 × 900, dark theme, saved at 1x (each well under 300 KB).
- The Apply shot needs the in-app browser tab, which is a native `WebContentsView` and absent from a renderer
  screenshot; the spec captures the window and the tab in the main process and draws the tab over its bounds.
- The screenshot spec has its **own Playwright config** (`e2e/screenshots.config.ts`), so `npm run test:e2e`
  never writes into the repository. It is still type-checked by `npm run typecheck:e2e`.
- **Buy me a coffee** is a shields.io badge (Buy Me a Coffee yellow and logo) linking to the project's
  Buy Me a Coffee page, `https://buymeacoffee.com/silentashish`. It returns 200 (checked with `curl`). The first
  version linked a PayPal donate page; the Buy Me a Coffee page replaced it at the owner's request.
- The README's existing sections keep their text, commands, tables and links; only the head was replaced and a
  blank line removed. Section headings are unchanged, so existing anchors into the README keep working.

## Regenerating the screenshots

```bash
npm run screenshots   # electron-vite build, then e2e/screenshots/readme.spec.ts → docs/assets/screenshots/*.png
```

Look at every image before committing it. To add one, add a step to the spec (use the page objects in
`e2e/pages/`) and reference the file from the README.

## How to test

```bash
npm run check:docs                           # every relative link, image and anchor resolves; linked SVGs parse
npm run typecheck:e2e                        # the screenshot spec type-checks
npm run screenshots                          # regenerates the four PNGs (2 tests pass)
```

Then open the README on the branch on GitHub in light and dark mode: the logo, badges and screenshots render, the
Contents links jump to their sections, and the Buy me a coffee badges open buymeacoffee.com/silentashish.

## Follow-ups

- Light-theme screenshots shown with `<picture>` and `prefers-color-scheme`, if wanted.
- Run `scripts/check-doc-links.mjs` in CI over the README and `docs/`.
