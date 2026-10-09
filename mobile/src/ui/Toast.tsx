import { useEffect } from 'react'
import { Pressable } from 'react-native'
import Animated from 'react-native-reanimated'
import type { Toast as ToastData } from '../remote/model'
import { Icon } from './Icon'
import { radius, useColors } from './theme'
import { Txt } from './Txt'

/** A one-line message above the tab bar (a refused command, an expired one); tap or wait to dismiss. */
export function Toast({ toast, onDismiss, bottom }: { toast: ToastData | null; onDismiss: () => void; bottom: number }) {
  const colors = useColors()
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onDismiss, 5000)
    return () => clearTimeout(t)
  }, [toast, onDismiss])
  if (!toast) return null
  const fg = toast.tone === 'error' ? colors.danger : colors.info
  return (
    <Animated.View
      key={toast.id}
      style={{
        position: 'absolute',
        left: 20,
        right: 20,
        bottom,
        animationName: { from: { opacity: 0, transform: [{ translateY: 10 }] }, to: { opacity: 1, transform: [{ translateY: 0 }] } },
        animationDuration: 220,
        animationTimingFunction: 'ease-out'
      }}
    >
      <Pressable
        accessibilityRole="alert"
        onPress={onDismiss}
        style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: radius.lg, backgroundColor: colors.bgSurfaceRaised, borderWidth: 1, borderColor: colors.borderDefault }}
      >
        <Icon name={toast.tone === 'error' ? 'alert-circle' : 'info-circle'} size={16} color={fg} />
        <Txt variant="bodySm" style={{ flex: 1 }}>
          {toast.text}
        </Txt>
      </Pressable>
    </Animated.View>
  )
}
