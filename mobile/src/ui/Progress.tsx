import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { radius, useColors } from './theme'

/** 8 px track; the fill eases to its new width (Reanimated CSS transition). */
export function Progress({ value }: { value: number }) {
  const colors = useColors()
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100
  return (
    <View style={{ height: 8, borderRadius: radius.full, backgroundColor: colors.bgSubtle, overflow: 'hidden' }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}>
      <Animated.View
        style={{
          height: 8,
          borderRadius: radius.full,
          backgroundColor: colors.accentSecondary,
          width: `${pct}%`,
          transitionProperty: 'width',
          transitionDuration: 700,
          transitionTimingFunction: 'ease-out'
        }}
      />
    </View>
  )
}
