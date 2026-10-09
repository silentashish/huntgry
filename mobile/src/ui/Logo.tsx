import Svg, { Defs, Ellipse, LinearGradient, Rect, Stop } from 'react-native-svg'

/** The Huntgry paw on its ember tile, exported from the Figma "Logo" layer (72 × 72). */
export function Logo({ size = 72 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 72 72" fill="none" accessibilityLabel="Huntgry">
      <Defs>
        <LinearGradient id="hg-logo" x1="0" y1="0" x2="51.4286" y2="51.4286" gradientUnits="userSpaceOnUse">
          <Stop stopColor="#FFC46B" />
          <Stop offset="1" stopColor="#E66E0A" />
        </LinearGradient>
      </Defs>
      <Rect width="72" height="72" rx="21.6" fill="url(#hg-logo)" />
      <Ellipse cx="18.72" cy="21.96" rx="6.84" ry="7.56" fill="#07090D" />
      <Ellipse cx="30.24" cy="14.04" rx="6.84" ry="7.56" fill="#07090D" />
      <Ellipse cx="41.76" cy="14.04" rx="6.84" ry="7.56" fill="#07090D" />
      <Ellipse cx="53.28" cy="21.96" rx="6.84" ry="7.56" fill="#07090D" />
      <Ellipse cx="36" cy="45.36" rx="16.56" ry="12.96" fill="#07090D" />
    </Svg>
  )
}
