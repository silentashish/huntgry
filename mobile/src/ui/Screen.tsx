import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, View, type RefreshControlProps } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { DEMO } from '../state/config'
import { Icon } from './Icon'
import { useColors } from './theme'
import { Txt } from './Txt'

/** The 54 pt status-bar band of the Figma frames; on a phone the real inset when it is taller. */
export const STATUS_BAR = 54

/** Web demo only: the frame's "9:41" status bar, so screenshots line up with the Figma frames. */
function DemoStatusBar() {
  const colors = useColors()
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: STATUS_BAR, flexDirection: 'row', alignItems: 'center', paddingTop: 14, paddingBottom: 6, paddingHorizontal: 24 }} pointerEvents="none">
      <Txt variant="labelMd" style={{ flex: 1 }}>
        9:41
      </Txt>
      <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
        <Icon name="wifi" size={14} color={colors.textPrimary} stroke={1.5} />
        <Icon name="battery" size={16} color={colors.textPrimary} stroke={1.5} />
      </View>
    </View>
  )
}

export interface ScreenProps {
  children: ReactNode
  /** Scrolls the content (lists); otherwise it fills the screen (Pair, Offline, Run). */
  scroll?: boolean
  /** Pinned below the content (the reply box). */
  footer?: ReactNode
  gap?: number
  refreshControl?: React.ReactElement<RefreshControlProps>
}

/** The frame body: 8 pt below the status bar, 20 pt sides and bottom, 14 pt between blocks. */
export function Screen({ children, scroll, footer, gap = 14, refreshControl }: ScreenProps) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const top = Math.max(insets.top, STATUS_BAR) + 8
  const body = { paddingTop: top, paddingHorizontal: 20, paddingBottom: footer ? 14 : 20, gap }
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bgCanvas }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {scroll ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={body} refreshControl={refreshControl} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, body]}>{children}</View>
      )}
      {footer ? <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>{footer}</View> : null}
      {DEMO && Platform.OS === 'web' ? <DemoStatusBar /> : null}
    </KeyboardAvoidingView>
  )
}

/** Mono eyebrow + display title, with an optional control on the right (badge, Pause button). */
export function ScreenHeader({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        {eyebrow ? (
          <Txt variant="monoSm" color="textMuted" numberOfLines={1}>
            {eyebrow}
          </Txt>
        ) : null}
        <Txt variant="displayMd" numberOfLines={1}>
          {title}
        </Txt>
      </View>
      {right}
    </View>
  )
}
