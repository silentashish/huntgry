import { useId } from 'react'

/**
 * Brand mark (Figma "Logo / Paw" 22:592): the hound's paw on an Ember gradient tile.
 * Same geometry as the mobile app's logo (72 × 72 viewBox). Decorative by default.
 * A copy of components/first-run/PawLogo.tsx (#117), to be deduplicated once both branches merge.
 */
export function PawLogo({ size = 56, label }: { size?: number; label?: string }) {
  const gradient = `${useId()}-paw`
  const paw = { fill: 'var(--hg-ink-950)' }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="51.4286" y2="51.4286" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: 'var(--hg-ember-300)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hg-ember-600)' }} />
        </linearGradient>
      </defs>
      <rect width="72" height="72" rx="21.6" fill={`url(#${gradient})`} />
      <ellipse cx="18.72" cy="21.96" rx="6.84" ry="7.56" style={paw} />
      <ellipse cx="30.24" cy="14.04" rx="6.84" ry="7.56" style={paw} />
      <ellipse cx="41.76" cy="14.04" rx="6.84" ry="7.56" style={paw} />
      <ellipse cx="53.28" cy="21.96" rx="6.84" ry="7.56" style={paw} />
      <ellipse cx="36" cy="45.36" rx="16.56" ry="12.96" style={paw} />
    </svg>
  )
}
