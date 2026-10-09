import { Pressable } from 'react-native'
import Animated from 'react-native-reanimated'
import { useColors } from './theme'

/** Toggle/on|off: 36 × 20, knob 16; the knob and the fill ease between states. */
export function Toggle({ value, onChange, label, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const colors = useColors()
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} disabled={disabled} hitSlop={10} onPress={() => onChange(!value)}>
      <Animated.View
        style={{
          width: 36,
          height: 20,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: value ? colors.accentPrimary : colors.borderDefault,
          backgroundColor: value ? colors.accentPrimary : colors.bgSubtle,
          justifyContent: 'center',
          opacity: disabled ? 0.5 : 1,
          transitionProperty: ['backgroundColor', 'borderColor'],
          transitionDuration: 180
        }}
      >
        <Animated.View
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: value ? colors.textOnAccent : colors.textMuted,
            transform: [{ translateX: value ? 17 : 2 }],
            transitionProperty: ['transform', 'backgroundColor'],
            transitionDuration: 180,
            transitionTimingFunction: 'ease-out'
          }}
        />
      </Animated.View>
    </Pressable>
  )
}
