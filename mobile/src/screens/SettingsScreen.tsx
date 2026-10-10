/**
 * Notification settings (Figma `19:534` / `19:1204`): push on this phone (#39), the five
 * categories (sent with `device.setNotifications`; the desktop then adds a push hint only for
 * those), the "Show details" note, this phone's name, the paired Mac and Unpair.
 */

import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@huntgry/remote-protocol'
import { useEffect, useRef, useState } from 'react'
import { Linking, TextInput, View } from 'react-native'
import { CATEGORY_LABEL } from '../notifications/categories'
import { describePush } from '../notifications/push'
import { usePush, usePushRegistrar } from '../notifications/PushProvider'
import { useModel, useNow, useRemote } from '../state/RemoteProvider'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { FadeIn } from '../ui/FadeIn'
import { ago, relayHost } from '../ui/format'
import { Icon } from '../ui/Icon'
import { Screen, ScreenHeader } from '../ui/Screen'
import { Toggle } from '../ui/Toggle'
import { radius, type, useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

export { CATEGORY_LABEL }

function Row({ children, border = true }: { children: React.ReactNode; border?: boolean }) {
  const colors = useColors()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: border ? 13 : 12,
        paddingVertical: border ? 11 : 10,
        borderRadius: radius.lg,
        backgroundColor: colors.bgSurface,
        borderWidth: border ? 1 : 0,
        borderColor: colors.borderSubtle
      }}
    >
      {children}
    </View>
  )
}

export function SettingsScreen() {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const now = useNow()
  const pairing = snap.pairing
  const [categories, setCategories] = useState<NotificationCategory[]>(pairing?.categories ?? [...NOTIFICATION_CATEGORIES])
  const [name, setName] = useState(pairing?.deviceName ?? '')
  const [confirm, setConfirm] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingCategories = useRef<NotificationCategory[] | null>(null)
  const push = describePush(usePush())
  const registrar = usePushRegistrar()

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (debounce.current) clearTimeout(debounce.current)
    // Leaving the screen within the debounce still sends the last choice.
    if (pendingCategories.current) void model.setNotifications(pendingCategories.current)
  }, [model])

  const toggle = (c: NotificationCategory, on: boolean) => {
    const next = on ? [...categories, c] : categories.filter((x) => x !== c)
    setCategories(next)
    pendingCategories.current = next
    // A burst of toggles is one command (the desktop allows a few writes a minute).
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      pendingCategories.current = null
      void model.setNotifications(next)
    }, 800)
  }

  const togglePush = (on: boolean) => {
    if (push.openSettings) {
      void Linking.openSettings()
      return
    }
    void (on ? registrar.enable() : registrar.disable())
  }

  const unpair = () => {
    if (!confirm) {
      setConfirm(true)
      timer.current = setTimeout(() => setConfirm(false), 4000)
      return
    }
    void model.unpair()
  }

  const presence = snap.presence
  const seen = presence ? (presence.online ? 'online now' : `last seen ${ago(presence.since, now)}`) : 'connecting'

  return (
    <Screen scroll>
      <ScreenHeader eyebrow="Pushed through Expo, one line each" title="Notifications" />
      <FadeIn index={0}>
        <Row>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="labelMd">Push notifications</Txt>
            <Txt variant="bodyXs" color="textMuted" style={{ lineHeight: 16 }}>
              {push.line}
            </Txt>
          </View>
          {push.openSettings ? (
            <Button variant="ghost" label="Open Settings" onPress={() => void Linking.openSettings()} />
          ) : (
            <Toggle label="Push notifications" value={push.on} disabled={!push.canToggle} onChange={togglePush} />
          )}
        </Row>
      </FadeIn>
      {NOTIFICATION_CATEGORIES.map((c, i) => (
        <FadeIn key={c} index={i + 1}>
          <Row>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="labelMd">{CATEGORY_LABEL[c]}</Txt>
              <Txt variant="bodyXs" color="textMuted" style={{ lineHeight: 16 }}>
                {c}
              </Txt>
            </View>
            <Toggle label={CATEGORY_LABEL[c]} value={categories.includes(c)} onChange={(on) => toggle(c, on)} />
          </Row>
        </FadeIn>
      ))}
      <Alert tone="info">Job and company names only appear in notifications if you turn that on in desktop Settings.</Alert>
      <View style={{ height: 1, backgroundColor: colors.borderSubtle }} />
      <Txt variant="monoSm" color="textMuted">
        Paired Mac
      </Txt>
      <Row border={false}>
        <Icon name="terminal" size={16} color={colors.iconDefault} />
        <View style={{ flex: 1, gap: 1 }}>
          <Txt variant="labelMd" numberOfLines={1}>
            {pairing?.desktopName ?? 'Your Mac'}
          </Txt>
          <Txt variant="monoXs" color="textMuted" numberOfLines={1}>
            {pairing ? `${relayHost(pairing.relay)} · ${seen}` : ''}
          </Txt>
        </View>
        <Button variant={confirm ? 'danger' : 'ghost'} label={confirm ? 'Tap to unpair' : 'Unpair'} onPress={unpair} />
      </Row>
      {confirm && (
        <Txt variant="bodyXs" color="textMuted">
          This deletes the keys on this phone. Revoke it under Settings → Remote control on your Mac too.
        </Txt>
      )}
      <Txt variant="monoSm" color="textMuted">
        This phone
      </Txt>
      <Row border={false}>
        <Icon name="device-mobile" size={16} color={colors.iconDefault} />
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={() => void model.setDeviceName(name)}
          onBlur={() => void model.setDeviceName(name)}
          maxLength={64}
          returnKeyType="done"
          accessibilityLabel="Name of this phone"
          placeholderTextColor={colors.textMuted}
          style={[type.labelMd, { flex: 1, color: colors.textPrimary, paddingVertical: 0 }]}
        />
      </Row>
      <Txt variant="bodyXs" color="textMuted">
        Your Mac shows this name in its device list.
      </Txt>
    </Screen>
  )
}
