# #107 — Scent Trail foundations in the desktop app

Issue: [silentashish/huntgry#107](https://github.com/silentashish/huntgry/issues/107) · Epic #95 (redesign 1/11) · Design: Figma `zhNccc831dRnOhj2tmqqkc` (🧭 Foundations, 🧩 Components, 🖥 App · Dark / Light)

## Context & problem

The redesign (#95) moves every screen onto the Scent Trail design system: deep ink dark mode,
warm bone light mode, Ember as the single hunt accent, Trail (teal) for "already found",
Bricolage Grotesque / Geist / Geist Mono. Ten page tickets build on it in parallel, so this
ticket lands first with everything they share: the tokens, the fonts, a Mantine theme that
makes stock Mantine components look like 🧩 Components, the colour scheme preference, the
shared parts, and the navigation contract for the Profile + Knowledge graph merge. Pages and
the shell are not restyled here beyond what the theme gives them.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Tokens | `src/renderer/src/theme/tokens.css` | Every `--hg-*` variable of the Figma file (WEB code syntax), light and dark, same values as `mobile/src/ui/theme.ts`. Light is the base (`:root`), dark is `:root[data-mantine-color-scheme='dark']`, so the tokens follow Mantine's colour scheme. Also primitives (`--hg-ink-*`, `--hg-ember-*`, …), spacing `--hg-space-0…11`, radius `--hg-radius-xs…full`, `--hg-shadow-card`, `--hg-shadow-float`, `--hg-glow-ember`, and the font stacks `--hg-font-display / -ui / -mono`. Body background and text come from the tokens. |
| Fonts | `package.json`, both lockfiles, `main.tsx` | `@fontsource-variable/geist`, `geist-mono`, `bricolage-grotesque` (5.3.0, OFL). Vite copies the woff2 files into `out/renderer/assets`; nothing is fetched at run time and the CSP (`default-src 'self'`) needs no change. |
| Theme | `src/renderer/src/theme/theme.ts` | `createTheme`: Geist UI, Bricolage headings, Geist Mono monospace; `primaryColor: 'ember'`; 10-shade palettes `ember`, `trail`, `success`, `warning`, `danger`, `info`, `review`, with Mantine's `orange/teal/green/yellow/red/blue/violet/grape` pointing at the same tones and `dark` mapped onto the ink scale; radius xs 4 · sm 6 · md 10 (default) · lg 14 · xl 20; spacing xs 8 · sm 12 · md 16 · lg 24 · xl 32; font sizes xs 12 · sm 13 · md 15 · lg 16 · xl 20. `cssVariablesResolver` points Mantine's colour variables (`--mantine-color-body`, `-text`, `-dimmed`, `-red-filled`, `-teal-light`, …) at the tokens in both schemes. `variantColorResolver` adds the Figma button kinds (below). |
| Component styles | `src/renderer/src/theme/mantine.css` | Button / ActionIcon sizes, the ember glow on `variant="primary"`, Badge pills (no uppercase), inputs on `bg-surface-sunken` with `border-default` and an Ember focus border, Checkbox / Radio / Switch, Paper / Card surfaces, Modal / Drawer (raised surface, `bg-overlay` backdrop), Menu / Popover / Combobox dropdowns, Tooltip (inverse), Tabs (underline + pills), SegmentedControl (sunken track, raised indicator), Table (mono header row), Kbd, Progress, Alert, Anchor. h3–h6 `Title`s render in Geist; h1/h2 in Bricolage. |
| Colour scheme | `theme/useThemePreference.ts`, `main.tsx` | `MantineProvider` gets `localStorageColorSchemeManager({ key: 'huntgry-color-scheme' })` and `defaultColorScheme="auto"`. `useThemePreference()` returns `{ preference: 'system' \| 'light' \| 'dark', setPreference, resolved }` for the sidebar toggle and Settings → Appearance. |
| Shared parts | `src/renderer/src/components/ui/` | `PageHeader`, `KpiTile`, `StatusPill`, `ScoreRing`, `CompanyAvatar`, `MonoLabel`, `SectionCard`, `EmptyState`, `ProgressBar`, tone helpers; one file each, `index.ts` barrel, one CSS module (`ui.module.css`). Tests in `ui.test.tsx`. |
| Navigation | `src/renderer/src/navigation.ts` | `profile` params gain `view?: 'editor' \| 'graph' \| 'skills'` and `nodeId?: string` (`ProfileView` type). The `graph` page and `PAGES` are unchanged; the Shell and Profile tickets remove them. |

## Rules for page tickets

1. **Colours are tokens.** Use `var(--hg-…)` (CSS modules, `style`, Mantine `c`/`bg` props:
   `c="var(--hg-text-muted)"`). Never a hex value, never `light-dark()` branches, never
   `useComputedColorScheme` for colours: the tokens switch on their own.
2. **Text roles.** Page titles `display/md` (use `PageHeader`); card titles Geist semibold 16
   (`SectionCard` or `Title order={3}`); body 13 px (`Text size="sm"`); captions 12 px
   (`Text size="xs"`). `c="dimmed"` is `--hg-text-secondary`; use `var(--hg-text-muted)` for the
   quieter captions.
3. **Mono for every readout**: costs, tokens, durations, times, dates in lists, paths, ids, and
   the small spaced labels above values. Use `MonoLabel` (or `ff="monospace"` on a `Text`).
4. **Ember once per screen**: one `Button variant="primary"` (it carries the glow). Other actions
   use `default` (outline), `subtle` (ghost), `secondary` or `light` with a tone colour.
5. **Use the shared parts** instead of re-building pills, tiles, rings or avatars. If a part
   needs a prop, add it there (small, typed) rather than forking it in a page.
6. **Keep accessible names.** e2e page objects find page titles as `heading level 2`, cards as
   `.mantine-Card-root` with a heading, navbar entries by label. `PageHeader` renders an `h2`,
   `SectionCard` renders Mantine's `Card` with an `h3`.
7. **Figma references**: screenshots of every App · Dark / Light frame are in
   `/home/user/figma-cache/frames/` (`<page>-<nodeId>-<slug>.png`), token values in
   `/home/user/figma-cache/variables.json`. Check there before calling Figma.

### Button and colour cheat sheet

| Figma kind | Mantine |
| --- | --- |
| primary (+ glow) | `<Button variant="primary">` |
| primary without glow (a second solid button) | `<Button>` (`filled`, Ember, dark text) |
| secondary | `<Button variant="secondary">` |
| outline | `<Button variant="default">` |
| ghost | `<Button variant="subtle">` (secondary text; `color="red"` etc. for tone text) |
| trail | `<Button variant="light" color="trail">` |
| danger | `<Button variant="light" color="danger">` (solid: `color="danger"`) |
| inverse | `<Button variant="inverse">` |
| icon button plain / bordered / filled / accent | `ActionIcon` `subtle` / `default` / `secondary` / `filled` |
| sizes sm 26 · md 34 · lg 46 | `size="xs"` · default (`sm`) · `size="lg"` |

`color` accepts the tone names `ember`, `trail`, `success`, `warning`, `danger`, `info`,
`review`; Mantine's own names map onto them (`orange`→ember, `teal`/`cyan`→trail,
`green`/`lime`→success, `yellow`→warning, `red`/`pink`→danger, `blue`/`indigo`→info,
`violet`/`grape`→review, `gray`→neutral). `Badge` defaults to `variant="light"` (the Figma
"filled" soft pill). `SegmentedControl` and `Tabs` (`variant="pills"` for the Jobs filter) are
themed: no separate segmented part was needed.

## Shared parts

All from `components/ui` (`import { PageHeader, … } from '../../components/ui'`).

### PageHeader

```tsx
<PageHeader
  eyebrow="The scent board · 31 saved"
  title="Jobs"
  subtitle="Ranked by how strongly each posting smells like your master profile."
  actions={<><Button variant="default" leftSection={<IconClipboardCheck size={16} />}>Paste a job</Button>
            <Button variant="primary" leftSection={<IconSparkles size={16} />}>Tailor all (3)</Button></>}
/>
```

Props: `title`, `eyebrow?` (mono line), `subtitle?`, `actions?`, `titleOrder?: 1 | 2` (default 2), `className?`.

### KpiTile

```tsx
<KpiTile label="Total" value={24} selected={filter === 'all'} onClick={() => setFilter('all')} />
<KpiTile label="Est. API cost" value="$14.20" sub="$0.37/run · $0.46/resume" />
<KpiTile label="Active time" value="4m 12s" size="sm" />   {/* run metrics, job facts */}
```

Props: `label`, `value`, `sub?`, `selected?` (Ember border), `accent?` (Ember value), `size?: 'sm' | 'md'`,
`onClick?` (then a toggle button with `aria-pressed`), `aria-label?`, `className?`.

### StatusPill

```tsx
<StatusPill tone="success" dot>Finished</StatusPill>
<StatusPill tone="warning" variant="outline">Unreviewed</StatusPill>
<StatusPill tone="accent" variant="solid">New</StatusPill>
```

Props: `children`, `tone?: UiTone` (`neutral` default, `accent`, `trail`, `success`, `warning`, `danger`,
`info`, `review`), `variant?: 'soft' | 'outline' | 'solid'`, `dot?`, `leftSection?`, `size?: 'sm' | 'md'`,
`title?`, `className?`.

### ScoreRing

```tsx
<ScoreRing value={score} caption="scent" />            {/* Jobs list, 44 px */}
<ScoreRing value={92} size="lg" />                      {/* job drawer, 56 px */}
<ScoreRing mode="done" />                               {/* already tailored */}
<ScoreRing mode="initial" letter="N" size="sm" />       {/* no score yet */}
```

Props: `mode?: 'score' | 'done' | 'initial'`, `value?` (0–100, clamped), `letter?`, `size?: 'sm' | 'md' | 'lg'`
(32 / 44 / 56), `tone?`, `caption?`, `aria-label?` (default "Scent 92 of 100"), `className?`.
`scoreTone(value)`: ≥ 80 accent, ≥ 60 warning, else neutral. `scoreLabel(value)`: "Strong / Fair / Faint scent".

### CompanyAvatar

```tsx
<CompanyAvatar name="Stripe" />                                   {/* "St", stable tone */}
<CompanyAvatar name="Ashish Gautam" shape="circle" size="lg" tone="accent" />
```

Props: `name`, `size?: 'sm' | 'md' | 'lg'` (24 / 32 / 56), `tone?: AvatarTone` (a `UiTone` or `inverse`),
`shape?: 'square' | 'circle'`, `className?`. Helpers `initialsOf(name)`, `avatarToneOf(name)`.

### MonoLabel

```tsx
<MonoLabel>4m 12s · 61k tok · $0.44</MonoLabel>
<MonoLabel size="xs" tone="secondary">scent</MonoLabel>
```

Props: `children`, `size?: 'xs' | 'sm'` (10 / 11 px), `tone?: 'muted' | 'secondary' | 'primary' | 'accent' | 'inherit'`,
`component?: 'span' | 'div' | 'p'`, `title?`, `className?`.

### SectionCard

```tsx
<SectionCard
  title="Last unattended pipeline"
  icon={<IconCpu size={18} />}
  badge={<StatusPill tone="success" dot>Finished</StatusPill>}
  actions={<Button size="xs" variant="subtle">Open the queue</Button>}
  accent="trail"
>
  …
</SectionCard>
```

Props: `title?`, `titleOrder?: 3 | 4`, `icon?`, `badge?`, `description?`, `actions?`, `accent?: 'ember' | 'trail'`,
`padding?` (default `lg`), `children?`, `className?`, `aria-label?`. Renders Mantine `Card` (`withBorder`, radius xl).

### EmptyState

```tsx
<EmptyState
  icon={<IconWorld size={28} />}
  title="No pages open"
  description="Open a posting from Jobs or the Dashboard, or enter a URL above."
  actions={<><Button variant="primary">New tab</Button><Button variant="default">Go to Jobs</Button></>}
  hint={<><Kbd>⌘L</Kbd> address bar <Kbd>⌘T</Kbd> new tab</>}
/>
<EmptyState compact tone="review" icon={<IconClipboardCheck size={22} />} title="Nothing to review" />
```

Props: `title`, `icon?`, `tone?` (default `accent`, which glows), `titleOrder?: 2 | 3 | 4`, `description?`,
`actions?`, `hint?`, `compact?`, `className?`.

### ProgressBar

```tsx
<ProgressBar value={25} tone="trail" aria-label="5 of 20 jobs" />
<ProgressBar value={70} size="xs" />
```

Props: `value` (0–100), `tone?` (default `accent`), `size?: 'xs' | 'sm' | 'md'` (4 / 6 / 8 px), `aria-label?`, `className?`.
Mantine's `Progress` is themed too.

### Tones and the theme preference

`UiTone`, `UI_TONES`, `TONE_VARS` and `toneStyle(tone)` (sets `--tone-fg`, `--tone-soft`,
`--tone-solid`, `--tone-on-solid` for a CSS module) are exported for parts a page adds itself.

```tsx
const { preference, setPreference, resolved } = useThemePreference()   // from '../../theme'
<SegmentedControl value={preference} onChange={(v) => setPreference(v as ThemePreference)}
  data={THEME_PREFERENCES.map((p) => ({ value: p, label: THEME_PREFERENCE_LABELS[p] }))} />
```

## Decisions and alternatives

- **Token-backed Mantine variables instead of per-scheme theme values.** Mantine's colour
  variables are pointed at `var(--hg-…)` in both schemes, so one theme serves light and dark and
  a token change in `tokens.css` reaches every Mantine component. Palettes still have 10 real
  shades for the few places that read numbered shades.
- **Mantine colour names keep working.** Existing pages use `red`, `gray`, `yellow`, `orange`,
  `green`, `teal`, `blue`, `grape`; they now render with the Scent Trail tones, so pages that
  have not been redesigned yet already look close.
- **Own `StatusPill` instead of Mantine `Badge`.** The Figma pill (tone × soft/outline/dot,
  18 px, 11 px medium) needs no Badge sizing overrides per use; Badge is themed as well for
  existing code.
- **`SegmentedTabs` not built.** `SegmentedControl` and `Tabs variant="pills"` match the Figma
  Tabs & Segmented set with theme styles only.
- **Fonts from Fontsource variable packages**: one woff2 per subset and family, about 260 kB in
  all, no network access.

## How it was tested

- `npm run typecheck`, `npx vitest run` (new: `components/ui/ui.test.tsx`, `theme/theme.test.ts`,
  the profile params case in `navigation.test.ts`), `node scripts/check-lockfiles.mjs`,
  `npx electron-vite build`.
- e2e: `shell.spec.ts`, `dashboard.spec.ts`, `jobs.spec.ts`, `board.spec.ts`, `tailor.spec.ts`,
  `graph.spec.ts`, `profile-editor.spec.ts` under `xvfb-run` on Linux, with `DISPLAY` passed to
  the app by a local, uncommitted change to `e2e/fixtures/app.ts` (the harness does not pass it
  on Linux; see `docs/testing/e2e.md`).
- Screenshots of the running app (pages and a local parts gallery) in dark and light, compared
  with the Figma frames.
