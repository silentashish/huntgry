import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { Pressable, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from './Icon'
import { useColors } from './theme'
import { Txt } from './Txt'

export const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'queue', label: 'Queue', icon: 'list-check' },
  { name: 'review', label: 'Review', icon: 'clipboard-check' },
  { name: 'jobs', label: 'Jobs', icon: 'briefcase' },
  { name: 'settings', label: 'Settings', icon: 'settings' }
]

/** Routes that live under a tab without a button of their own (run and pipeline under Queue, as in the Figma frames; a result and its files under Review). */
const PARENT_TAB: Record<string, string> = { 'run/[id]': 'queue', pipeline: 'queue', result: 'review', files: 'review' }

/** The Figma tab bar: surface, top hairline, five 64 pt items, 22 pt icons, the active one in ember. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const current = state.routes[state.index]?.name ?? 'index'
  const active = PARENT_TAB[current] ?? current
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        backgroundColor: colors.bgSurface,
        borderTopWidth: 1,
        borderTopColor: colors.borderSubtle,
        paddingTop: 9,
        paddingHorizontal: 12,
        paddingBottom: Math.max(insets.bottom, 28)
      }}
    >
      {TABS.map((tab) => {
        const focused = tab.name === active
        const color = focused ? colors.textAccent : colors.textMuted
        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: focused }}
            onPress={() => {
              const route = state.routes.find((r) => r.name === tab.name)
              const event = navigation.emit({ type: 'tabPress', target: route?.key, canPreventDefault: true })
              if (!event.defaultPrevented) navigation.navigate(tab.name)
            }}
            style={({ pressed }) => ({ width: 64, alignItems: 'center', gap: 3, opacity: pressed ? 0.7 : 1 })}
          >
            <Animated.View style={{ transform: [{ scale: focused ? 1 : 0.96 }], transitionProperty: 'transform', transitionDuration: 160 }}>
              <Icon name={tab.icon} size={22} color={color} />
            </Animated.View>
            <Txt variant="labelSm" style={{ color }}>
              {tab.label}
            </Txt>
          </Pressable>
        )
      })}
    </View>
  )
}
