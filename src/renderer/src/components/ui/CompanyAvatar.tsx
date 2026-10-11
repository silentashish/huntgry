import { toneStyle, type UiTone } from './tones'
import classes from './ui.module.css'

/** Avatar colours: the status tones plus `inverse` (ink on bone in dark, bone on ink in light). */
export type AvatarTone = UiTone | 'inverse'

const AVATAR_TONES: readonly AvatarTone[] = ['info', 'inverse', 'review', 'accent', 'neutral', 'danger', 'trail', 'success', 'warning']

/**
 * Two letters for a name: the first letters of the first two words ("Ashish Gautam" → "AG"), or
 * the first two letters of a single word ("Stripe" → "St").
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s\-_.·/]+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (words.length === 0) return '?'
  if (words.length === 1) {
    const [a = '', b = ''] = Array.from(words[0].replace(/[^\p{L}\p{N}]/gu, ''))
    return (a.toUpperCase() + b.toLowerCase()) || '?'
  }
  const first = (w: string): string => Array.from(w.replace(/[^\p{L}\p{N}]/gu, ''))[0] ?? ''
  return (first(words[0]) + first(words[1])).toUpperCase()
}

/** A stable tone for a name, so a company keeps its colour across pages and sessions. */
export function avatarToneOf(name: string): AvatarTone {
  let h = 0
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_TONES[h % AVATAR_TONES.length]
}

export interface CompanyAvatarProps {
  /** Company (or person) name; the initials and the colour come from it. */
  name: string
  /** 24 px, 32 px (default, tables and lists) or 56 px (profile header). */
  size?: 'sm' | 'md' | 'lg'
  /** Override the colour picked from the name. */
  tone?: AvatarTone
  /** `square` (rounded, companies; default) or `circle` (people). */
  shape?: 'square' | 'circle'
  className?: string
}

/** Rounded square with two initials (Figma Data display → avatar; Dashboard application rows). */
export function CompanyAvatar({ name, size = 'md', tone, shape = 'square', className }: CompanyAvatarProps) {
  const resolved = tone ?? avatarToneOf(name)
  return (
    <span
      className={className ? `${classes.avatar} ${className}` : classes.avatar}
      style={resolved === 'inverse' ? undefined : toneStyle(resolved)}
      data-tone={resolved}
      data-size={size}
      data-shape={shape}
      role="img"
      aria-label={name}
    >
      <span aria-hidden>{initialsOf(name)}</span>
    </span>
  )
}
