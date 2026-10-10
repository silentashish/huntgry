import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import Animated, { type CSSAnimationKeyframes } from 'react-native-reanimated'

const RISE: CSSAnimationKeyframes = {
  from: { opacity: 0, transform: [{ translateY: 6 }] },
  to: { opacity: 1, transform: [{ translateY: 0 }] }
}

/**
 * List items and cards rise 6 pt and fade in, a beat after the previous one. A Reanimated 4
 * CSS animation (UI thread on the phone, plain CSS on the web), run once on mount.
 */
export function FadeIn({ children, index = 0, style }: { children: ReactNode; index?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Animated.View
      style={[
        {
          animationName: RISE,
          animationDuration: 280,
          animationDelay: Math.min(index, 8) * 45,
          animationFillMode: 'backwards',
          animationTimingFunction: 'ease-out'
        },
        style
      ]}
    >
      {children}
    </Animated.View>
  )
}
