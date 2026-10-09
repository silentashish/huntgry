/**
 * Pair (Figma `19:2` / `19:672`): scan the QR from Settings → Remote control on the Mac (or
 * paste the code, or open a `huntgry://pair?…` link), wait for the owner to approve on the
 * Mac, then the tabs. Also the "Pair again" state after a denial, a revoke or an unpair.
 */

import { CameraView, useCameraPermissions } from 'expo-camera'
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Platform, TextInput, View } from 'react-native'
import Animated from 'react-native-reanimated'
import type { PairingStep } from '../remote/pairing'
import { useModel, useNow, useRemote } from '../state/RemoteProvider'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { FadeIn } from '../ui/FadeIn'
import { Icon } from '../ui/Icon'
import { Logo } from '../ui/Logo'
import { Screen } from '../ui/Screen'
import { radius, type, useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

const BOX = 260
const FRAME = 200

/** The four ember corners of the viewfinder (the Figma frame's 3 pt dashed outline). */
function Corners() {
  const colors = useColors()
  const arm = 36
  const offset = (BOX - FRAME) / 2 - 1
  const corner = (pos: object, sides: object) => <View style={[{ position: 'absolute', width: arm, height: arm, borderColor: colors.accentPrimary }, pos, sides]} />
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      {corner({ top: offset, left: offset }, { borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 16 })}
      {corner({ top: offset, right: offset }, { borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 16 })}
      {corner({ bottom: offset, left: offset }, { borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 16 })}
      {corner({ bottom: offset, right: offset }, { borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 16 })}
    </View>
  )
}

/** Rebuilds the deep link from expo-router's params, in the QR's field order. */
function deepLink(params: Record<string, string | string[] | undefined>): string | null {
  const keys = ['v', 'relay', 'room', 'pairing', 'pk', 's', 'exp']
  if (!keys.every((k) => typeof params[k] === 'string')) return null
  return 'huntgry://pair?' + keys.map((k) => `${k}=${encodeURIComponent(params[k] as string)}`).join('&')
}

function Waiting({ step, now }: { step: Extract<PairingStep, { step: 'waiting' }>; now: number }) {
  const colors = useColors()
  const left = Math.max(0, step.invite.exp - Math.floor(now / 1000))
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 20 }}>
      <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View
          style={{
            position: 'absolute',
            width: 44,
            height: 44,
            borderRadius: 22,
            borderWidth: 2,
            borderColor: colors.accentPrimary,
            animationName: { '0%': { opacity: 0.8, transform: [{ scale: 0.6 }] }, '100%': { opacity: 0, transform: [{ scale: 1.4 }] } },
            animationDuration: '1600ms',
            animationIterationCount: 'infinite',
            animationTimingFunction: 'ease-out'
          }}
        />
        <Icon name="device-mobile" size={22} color={colors.textAccent} />
      </View>
      <Txt variant="headingSm" align="center">
        Approve this phone on your Mac
      </Txt>
      <Txt variant="bodyXs" color="textSecondary" align="center">
        {step.queued ? 'Your Mac is not connected to the relay yet: open Huntgry on it.' : 'Huntgry on your Mac asks “Pair this phone?”.'} The code is valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
      </Txt>
    </View>
  )
}

function Outcome({ icon, tone, title, body }: { icon: 'alert-circle' | 'alert-triangle'; tone: 'danger' | 'warning'; title: string; body: string }) {
  const colors = useColors()
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 20 }}>
      <Icon name={icon} size={32} color={tone === 'danger' ? colors.danger : colors.warning} />
      <Txt variant="headingSm" align="center">
        {title}
      </Txt>
      <Txt variant="bodyXs" color="textSecondary" align="center">
        {body}
      </Txt>
    </View>
  )
}

export function PairScreen() {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const params = useLocalSearchParams()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanning, setScanning] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [code, setCode] = useState('')
  const scanned = useRef(false)
  const step = snap.pairingStep
  const busy = step.step === 'connecting' || step.step === 'waiting'
  const now = useNow(1000)

  // huntgry://pair?… opened from the camera app or a link: pair straight away.
  const link = deepLink(params)
  useEffect(() => {
    if (link && step.step === 'idle') void model.pair(link)
    // Only once per link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  const start = async () => {
    model.resetPairing()
    if (Platform.OS === 'web') {
      setPasting(true)
      return
    }
    if (!permission?.granted) {
      const answer = await requestPermission()
      if (!answer.granted) {
        setPasting(true)
        return
      }
    }
    scanned.current = false
    setScanning(true)
  }

  const submit = (text: string) => {
    setScanning(false)
    setPasting(false)
    void model.pair(text)
  }

  let inside: React.ReactNode = null
  if (step.step === 'waiting') inside = <Waiting step={step} now={now} />
  else if (step.step === 'connecting') inside = <Txt variant="labelSm" color="textSecondary">Reaching the relay…</Txt>
  else if (step.step === 'denied') inside = <Outcome icon="alert-circle" tone="danger" title="Your Mac declined this phone" body="Ask for a new code on the Mac if that was a mistake." />
  else if (step.step === 'expired') inside = <Outcome icon="alert-triangle" tone="warning" title="This code expired" body="Show a new one in Settings → Remote control on your Mac, then scan again." />
  else if (step.step === 'error') inside = <Outcome icon="alert-triangle" tone="warning" title="Could not pair" body={step.message} />

  const label = busy ? 'Cancel' : step.step === 'idle' ? 'Scan to pair' : 'Scan again'

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <FadeIn>
          <Logo />
        </FadeIn>
        <Txt variant="displayLg">Huntgry</Txt>
        {snap.pairAgain ? (
          <View style={{ width: '100%' }}>
            <Alert tone="warning" title="Pair again">
              {snap.pairAgain.message}
            </Alert>
          </View>
        ) : (
          <Txt variant="bodyMd" color="textSecondary" align="center" style={{ width: 330, maxWidth: '100%' }}>
            Watch and steer the hunt from your pocket. Your Mac does the work; the phone only talks to it through your own encrypted relay.
          </Txt>
        )}
        <View style={{ width: BOX, height: BOX, borderRadius: radius['2xl'], borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurfaceSunken, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
          {scanning && !busy ? (
            <CameraView
              style={{ position: 'absolute', inset: 0 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (scanned.current) return
                scanned.current = true
                submit(data)
              }}
            />
          ) : null}
          {pasting && !busy ? (
            <View style={{ width: FRAME, gap: 8 }}>
              <TextInput
                value={code}
                onChangeText={setCode}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                placeholder="huntgry://pair?v=1&…"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Pairing code"
                style={[type.monoXs, { height: 110, color: colors.textPrimary, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurface, textAlignVertical: 'top' }]}
              />
              <Button variant="primary" label="Pair" icon="check" disabled={!code.trim()} onPress={() => submit(code)} />
            </View>
          ) : (
            inside
          )}
          {!pasting && <Corners />}
          {!pasting && !inside && (
            <Txt variant="labelSm" color="textSecondary" align="center" style={{ position: 'absolute', top: 199, width: FRAME }}>
              Point at the QR in Settings → Remote control
            </Txt>
          )}
        </View>
        <Button
          size="lg"
          variant={busy ? 'outline' : 'primary'}
          icon={busy ? 'x' : 'qrcode'}
          label={label}
          style={{ width: BOX }}
          onPress={() => {
            if (busy) model.cancelPairing()
            else void start()
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="shield-check" size={14} color={colors.accentSecondary} />
          <Txt variant="monoXs" color="textMuted">
            Can never submit an application or edit settings
          </Txt>
        </View>
        {!busy && !pasting && Platform.OS !== 'web' && (
          <Button variant="ghost" icon="clipboard" label="Paste a code instead" onPress={() => { setScanning(false); setPasting(true) }} />
        )}
      </View>
    </Screen>
  )
}
