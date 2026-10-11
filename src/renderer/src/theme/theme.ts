import {
  createTheme,
  defaultVariantColorsResolver,
  localStorageColorSchemeManager,
  type ActionIconVariant,
  type ButtonVariant,
  type CSSVariablesResolver,
  type DefaultMantineColor,
  type MantineColorsTuple,
  type VariantColorsResolver
} from '@mantine/core'

/**
 * The Scent Trail Mantine theme (#107). Colours come from the --hg-* tokens in tokens.css, so every
 * value here follows the colour scheme without a light/dark branch: Mantine's colour variables are
 * pointed at the tokens (cssVariablesResolver), and component defaults use the tokens directly
 * (mantine.css). The 10-shade palettes below exist for the few places that read a numbered shade
 * (`c="red.6"`); they hold the same primitives.
 */

/** Ember: the hunt accent, once per screen. */
const ember: MantineColorsTuple = ['#fff7ee', '#ffefdf', '#ffd9ae', '#ffc46b', '#ffa53d', '#ff8a1f', '#e66e0a', '#b85405', '#7a3a06', '#2a1b0e']
/** Trail: secondary, "already found" states. */
const trail: MantineColorsTuple = ['#effbf8', '#dff7f1', '#b2eee0', '#7fe8d2', '#3be3c2', '#1fc4a5', '#0e9e85', '#0b7b68', '#0a4f44', '#0e2a26']
const success: MantineColorsTuple = ['#effbf3', '#dcf7e6', '#b4eec9', '#84e2a6', '#5bd889', '#3ecf72', '#1fa85a', '#178446', '#105a31', '#0e2a1a']
const warning: MantineColorsTuple = ['#fffae6', '#fff4cc', '#ffe48a', '#ffd54d', '#fbc61f', '#f5b700', '#c99400', '#9c7300', '#5e4504', '#2a2208']
const danger: MantineColorsTuple = ['#fef1f1', '#fde2e3', '#fac0c2', '#f7959a', '#f4747a', '#f2555a', '#d23a40', '#a82c31', '#6e1d21', '#2e1214']
const info: MantineColorsTuple = ['#f0f5ff', '#e0ebff', '#bcd3ff', '#93b8ff', '#6fa1ff', '#4f8dff', '#3470e0', '#2857ae', '#1a3970', '#0f1b33']
const review: MantineColorsTuple = ['#f6f3ff', '#ece6ff', '#d6caff', '#bea9ff', '#ab90ff', '#9b7bff', '#7a5be0', '#5f45b3', '#3c2c73', '#1c1533']
/** Light-scheme neutrals: bone surfaces, ink text. Mantine reads gray-0…4 for hovers and borders. */
const gray: MantineColorsTuple = ['#f4f2ec', '#efece4', '#e9e5dc', '#e9e5dc', '#d9e0e8', '#8494a8', '#5b6b80', '#3d4a5c', '#1e2836', '#0b0f15']
/** Dark-scheme neutrals mapped onto the ink scale: 0 text, 2 dimmed, 3 placeholder, 4 borders, 5 hover, 6 raised, 7 body. */
const dark: MantineColorsTuple = ['#eef2f6', '#b3bfce', '#8494a8', '#5b6b80', '#1e2836', '#151d28', '#10161f', '#0b0f15', '#07090d', '#040507']

/** Semantic colour names page code can pass as `color` (besides Mantine's own, which map onto them). */
export type HgColor = 'ember' | 'trail' | 'success' | 'warning' | 'danger' | 'info' | 'review'

type ExtendedColor = HgColor | DefaultMantineColor
/** `variant` values added to Button and ActionIcon (see variantColorResolver). */
type ExtraVariant = 'primary' | 'secondary' | 'inverse'

declare module '@mantine/core' {
  export interface MantineThemeColorsOverride {
    colors: Record<ExtendedColor, MantineColorsTuple>
  }
  export interface ButtonProps {
    variant?: ButtonVariant | ExtraVariant
  }
  export interface ActionIconProps {
    variant?: ActionIconVariant | ExtraVariant
  }
}

/** One status tone in tokens: solid fill, its hover, the soft background and the text colour on it. */
interface Tone {
  fill: string
  hover: string
  soft: string
  text: string
  /** Text on the solid fill. */
  onFill: string
}

const darker = (v: string): string => `color-mix(in srgb, ${v} 86%, black)`

const TONES: Record<'ember' | 'trail' | 'success' | 'warning' | 'danger' | 'info' | 'review' | 'neutral', Tone> = {
  ember: {
    fill: 'var(--hg-accent-primary)',
    hover: 'var(--hg-accent-primary-hover)',
    soft: 'var(--hg-accent-primary-soft)',
    text: 'var(--hg-text-accent)',
    onFill: 'var(--hg-text-on-accent)'
  },
  trail: {
    fill: 'var(--hg-accent-secondary)',
    hover: darker('var(--hg-accent-secondary)'),
    soft: 'var(--hg-accent-secondary-soft)',
    text: 'var(--hg-accent-secondary)',
    onFill: 'var(--hg-text-on-accent)'
  },
  success: {
    fill: 'var(--hg-status-success)',
    hover: darker('var(--hg-status-success)'),
    soft: 'var(--hg-status-success-soft)',
    text: 'var(--hg-status-success)',
    onFill: 'var(--hg-text-on-accent)'
  },
  warning: {
    fill: 'var(--hg-status-warning)',
    hover: darker('var(--hg-status-warning)'),
    soft: 'var(--hg-status-warning-soft)',
    text: 'var(--hg-status-warning)',
    onFill: 'var(--hg-text-on-accent)'
  },
  danger: {
    fill: 'var(--hg-status-danger)',
    hover: darker('var(--hg-status-danger)'),
    soft: 'var(--hg-status-danger-soft)',
    text: 'var(--hg-status-danger)',
    onFill: '#ffffff'
  },
  info: {
    fill: 'var(--hg-status-info)',
    hover: darker('var(--hg-status-info)'),
    soft: 'var(--hg-status-info-soft)',
    text: 'var(--hg-status-info)',
    onFill: '#ffffff'
  },
  review: {
    fill: 'var(--hg-status-review)',
    hover: darker('var(--hg-status-review)'),
    soft: 'var(--hg-status-review-soft)',
    text: 'var(--hg-status-review)',
    onFill: '#ffffff'
  },
  neutral: {
    fill: 'var(--hg-text-muted)',
    hover: 'var(--hg-text-secondary)',
    soft: 'var(--hg-bg-subtle)',
    text: 'var(--hg-text-secondary)',
    onFill: 'var(--hg-bg-surface)'
  }
}

/** Mantine colour names (and ours) → the Scent Trail tone they render with. */
const COLOR_TONES: Record<string, keyof typeof TONES> = {
  ember: 'ember',
  orange: 'ember',
  trail: 'trail',
  teal: 'trail',
  cyan: 'trail',
  success: 'success',
  green: 'success',
  lime: 'success',
  warning: 'warning',
  yellow: 'warning',
  danger: 'danger',
  red: 'danger',
  pink: 'danger',
  info: 'info',
  blue: 'info',
  indigo: 'info',
  review: 'review',
  violet: 'review',
  grape: 'review',
  gray: 'neutral'
}

/** The tone a `color` prop renders with; `undefined` for raw CSS colours and `dark`. */
export function toneOf(color: string | undefined): keyof typeof TONES | undefined {
  if (!color) return 'ember'
  return COLOR_TONES[color.split('.')[0]]
}

function colorVariables(name: string, tone: Tone): Record<string, string> {
  return {
    [`--mantine-color-${name}-text`]: tone.text,
    [`--mantine-color-${name}-filled`]: tone.fill,
    [`--mantine-color-${name}-filled-hover`]: tone.hover,
    [`--mantine-color-${name}-light`]: tone.soft,
    [`--mantine-color-${name}-light-hover`]: `color-mix(in srgb, ${tone.soft}, ${tone.fill} 12%)`,
    [`--mantine-color-${name}-light-color`]: tone.text,
    [`--mantine-color-${name}-outline`]: tone.fill,
    [`--mantine-color-${name}-outline-hover`]: `color-mix(in srgb, ${tone.fill} 8%, transparent)`
  }
}

/** The same overrides in both schemes: the tokens they point at do the switching. */
function schemeVariables(): Record<string, string> {
  const vars: Record<string, string> = {
    '--mantine-color-body': 'var(--hg-bg-canvas)',
    '--mantine-color-text': 'var(--hg-text-primary)',
    '--mantine-color-bright': 'var(--hg-text-primary)',
    '--mantine-color-dimmed': 'var(--hg-text-secondary)',
    '--mantine-color-placeholder': 'var(--hg-text-muted)',
    '--mantine-color-anchor': 'var(--hg-text-link)',
    '--mantine-color-error': 'var(--hg-status-danger)',
    '--mantine-color-success': 'var(--hg-status-success)',
    '--mantine-color-default': 'var(--hg-bg-surface)',
    '--mantine-color-default-hover': 'var(--hg-bg-subtle)',
    '--mantine-color-default-color': 'var(--hg-text-primary)',
    '--mantine-color-default-border': 'var(--hg-border-default)',
    '--mantine-color-disabled': 'var(--hg-bg-subtle)',
    '--mantine-color-disabled-color': 'var(--hg-text-muted)',
    '--mantine-color-disabled-border': 'var(--hg-border-subtle)',
    '--mantine-primary-color-contrast': 'var(--hg-text-on-accent)'
  }
  for (const [name, tone] of Object.entries(COLOR_TONES)) Object.assign(vars, colorVariables(name, TONES[tone]))
  return vars
}

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: schemeVariables(),
  dark: schemeVariables()
})

/**
 * Variants: `filled` is the solid tone (ember by default, dark text on ember/trail/warning/success),
 * `light` the soft pill look, `default` the Figma "outline" kind, `subtle` the "ghost" kind
 * (secondary text unless a colour is given). Added: `primary` (ember + glow/ember, one per
 * screen), `secondary` (bg-subtle), `inverse`.
 */
export const variantColorResolver: VariantColorsResolver = (input) => {
  const base = defaultVariantColorsResolver(input)
  const tone = toneOf(input.color)
  switch (input.variant) {
    case 'primary':
      return {
        background: TONES.ember.fill,
        hover: TONES.ember.hover,
        color: TONES.ember.onFill,
        hoverColor: TONES.ember.onFill,
        border: '1px solid transparent'
      }
    case 'secondary':
      return {
        background: 'var(--hg-bg-subtle)',
        hover: 'color-mix(in srgb, var(--hg-bg-subtle), var(--hg-text-primary) 8%)',
        color: 'var(--hg-text-primary)',
        hoverColor: 'var(--hg-text-primary)',
        border: '1px solid transparent'
      }
    case 'inverse':
      return {
        background: 'var(--hg-bg-inverse)',
        hover: 'color-mix(in srgb, var(--hg-bg-inverse) 88%, var(--hg-bg-canvas))',
        color: 'var(--hg-text-inverse)',
        hoverColor: 'var(--hg-text-inverse)',
        border: '1px solid transparent'
      }
    case 'default':
      return {
        background: 'transparent',
        hover: 'var(--hg-bg-hover)',
        color: 'var(--hg-text-primary)',
        hoverColor: 'var(--hg-text-primary)',
        border: '1px solid var(--hg-border-default)'
      }
    case 'subtle':
      if (!input.color || tone === 'neutral') {
        return {
          background: 'transparent',
          hover: 'var(--hg-bg-hover)',
          color: 'var(--hg-text-secondary)',
          hoverColor: 'var(--hg-text-primary)',
          border: '1px solid transparent'
        }
      }
      return tone ? { ...base, color: TONES[tone].text, hover: 'var(--hg-bg-hover)' } : base
    case 'filled':
      return tone ? { ...base, background: TONES[tone].fill, hover: TONES[tone].hover, color: TONES[tone].onFill } : base
    default:
      return base
  }
}

export const colorSchemeManager = localStorageColorSchemeManager({ key: 'huntgry-color-scheme' })

const FONT_UI = "'Geist Variable', 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
const FONT_DISPLAY = "'Bricolage Grotesque Variable', 'Bricolage Grotesque', 'Geist Variable', system-ui, sans-serif"
const FONT_MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

export const theme = createTheme({
  primaryColor: 'ember',
  primaryShade: { light: 6, dark: 5 },
  colors: { ember, trail, success, warning, danger, info, review, orange: ember, teal: trail, green: success, yellow: warning, red: danger, blue: info, violet: review, grape: review, gray, dark },
  white: '#ffffff',
  black: '#0b0f15',
  fontFamily: FONT_UI,
  fontFamilyMonospace: FONT_MONO,
  headings: {
    fontFamily: FONT_DISPLAY,
    fontWeight: '700',
    sizes: {
      h1: { fontSize: '40px', lineHeight: '46px' },
      // display/md: page titles.
      h2: { fontSize: '32px', lineHeight: '38px' },
      // h3–h6 render in Geist (mantine.css): card and section titles.
      h3: { fontSize: '20px', lineHeight: '26px', fontWeight: '600' },
      h4: { fontSize: '16px', lineHeight: '22px', fontWeight: '600' },
      h5: { fontSize: '14px', lineHeight: '20px', fontWeight: '600' },
      h6: { fontSize: '13px', lineHeight: '18px', fontWeight: '600' }
    }
  },
  // body/xs, body/sm, body/md, heading/md, heading/lg
  fontSizes: { xs: '12px', sm: '13px', md: '15px', lg: '16px', xl: '20px' },
  lineHeights: { xs: '1.34', sm: '1.385', md: '1.47', lg: '1.375', xl: '1.3' },
  radius: { xs: '4px', sm: '6px', md: '10px', lg: '14px', xl: '20px' },
  defaultRadius: 'md',
  spacing: { xs: '8px', sm: '12px', md: '16px', lg: '24px', xl: '32px' },
  shadows: {
    xs: '0 1px 2px 0 rgb(0 0 0 / 8%)',
    sm: 'var(--hg-shadow-card)',
    md: 'var(--hg-shadow-card)',
    lg: 'var(--hg-shadow-float)',
    xl: 'var(--hg-shadow-float)'
  },
  cursorType: 'pointer',
  focusRing: 'auto',
  autoContrast: false,
  variantColorResolver,
  other: {
    fontDisplay: FONT_DISPLAY
  },
  components: {
    Badge: { defaultProps: { variant: 'light', radius: 'xl' } },
    Card: { defaultProps: { radius: 'xl', padding: 'md' } },
    Paper: { defaultProps: { radius: 'lg' } },
    Modal: { defaultProps: { radius: 'xl' } },
    Menu: { defaultProps: { radius: 'lg', shadow: 'lg' } },
    Popover: { defaultProps: { radius: 'lg', shadow: 'lg' } },
    Combobox: { defaultProps: { radius: 'lg', shadow: 'lg' } },
    Tooltip: { defaultProps: { radius: 'sm', openDelay: 300 } },
    Checkbox: { defaultProps: { radius: 'xs', iconColor: 'var(--hg-text-on-accent)' } },
    Kbd: { defaultProps: { size: 'xs' } },
    SegmentedControl: { defaultProps: { radius: 'md', size: 'xs' } },
    Progress: { defaultProps: { radius: 'xl' } }
  }
})
