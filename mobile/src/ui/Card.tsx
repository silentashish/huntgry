import type { ReactNode } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import { radius, useColors, type Colors } from './theme'

export interface CardProps {
  children: ReactNode
  /** Default: surface with a subtle border. `accent`: the "needs you" card. */
  tone?: 'surface' | 'accent' | 'raised'
  padding?: number
  gap?: number
  radius?: number
  border?: boolean
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
}

function toneStyle(colors: Colors, tone: CardProps['tone']): ViewStyle {
  switch (tone) {
    case 'accent':
      return { backgroundColor: colors.accentPrimarySoft, borderColor: colors.accentPrimary }
    case 'raised':
      return { backgroundColor: colors.bgSurfaceRaised, borderColor: colors.borderDefault }
    default:
      return { backgroundColor: colors.bgSurface, borderColor: colors.borderSubtle }
  }
}

export function Card({ children, tone = 'surface', padding = 14, gap = 10, radius: r = radius.xl, border = true, onPress, style, accessibilityLabel }: CardProps) {
  const colors = useColors()
  // Figma strokes sit inside the frame, React Native borders add to it: the padding gives the point back.
  const base: ViewStyle = { ...toneStyle(colors, tone), borderWidth: border ? 1 : 0, borderRadius: r, padding: border ? padding - 1 : padding, gap, overflow: 'hidden' }
  if (!onPress) return <View style={[base, style]}>{children}</View>
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={({ pressed }) => [base, pressed && { opacity: 0.85, transform: [{ scale: 0.995 }] }, style]}>
      {children}
    </Pressable>
  )
}
