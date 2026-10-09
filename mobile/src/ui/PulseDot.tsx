import { View } from 'react-native'
import Animated from 'react-native-reanimated'

/**
 * A status dot. `live`: a soft halo breathes out of it (Reanimated 4 CSS animation, on the UI
 * thread), for things that are happening now: Mac online, a running job, a run waiting.
 */
export function PulseDot({ color, size = 6, live = false }: { color: string; size?: number; live?: boolean }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {live && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            animationName: {
              '0%': { opacity: 0.55, transform: [{ scale: 1 }] },
              '70%': { opacity: 0, transform: [{ scale: 2.6 }] },
              '100%': { opacity: 0, transform: [{ scale: 2.6 }] }
            },
            animationDuration: '1800ms',
            animationIterationCount: 'infinite',
            animationTimingFunction: 'ease-out'
          }}
        />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  )
}
