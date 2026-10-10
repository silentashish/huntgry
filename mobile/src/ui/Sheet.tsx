import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { IconButton } from './Button'
import { radius, useColors } from './theme'
import { Txt } from './Txt'

/** A bottom sheet on the overlay colour: raised surface, 2xl top corners, title and close. */
export function Sheet({ visible, onClose, title, eyebrow, children, footer }: { visible: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; footer?: ReactNode }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, backgroundColor: colors.bgOverlay }} />
        <View
          style={{
            backgroundColor: colors.bgSurfaceRaised,
            borderTopLeftRadius: radius['2xl'],
            borderTopRightRadius: radius['2xl'],
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: colors.borderDefault,
            maxHeight: '88%',
            paddingBottom: Math.max(insets.bottom, 20)
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 36, height: 4, borderRadius: radius.full, backgroundColor: colors.borderStrong }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 }}>
            <View style={{ flex: 1, gap: 2 }}>
              {eyebrow ? (
                <Txt variant="monoSm" color="textMuted">
                  {eyebrow}
                </Txt>
              ) : null}
              <Txt variant="headingXl">{title}</Txt>
            </View>
            <IconButton icon="x" label="Close" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 12, gap: 16 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={{ paddingHorizontal: 20 }}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
