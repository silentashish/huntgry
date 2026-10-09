import { toBase64 } from '@huntgry/remote-protocol'
import { useMemo } from 'react'
import { ActivityIndicator, Image, Pressable, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { utf8Text } from '../remote/files'
import type { FileView } from '../remote/model'
import { DEMO } from '../state/config'
import { Icon } from './Icon'
import { palette, radius, useColors } from './theme'
import { Txt } from './Txt'

/** The paper of the Figma preview (white, radius xs, 8 pt padding, ink line placeholders). */
const LINES: [number, boolean][] = [
  [70, true],
  [133, false],
  [126, false],
  [119, false],
  [70, true],
  [105, false],
  [138, false],
  [131, false],
  [70, true],
  [117, false],
  [110, false],
  [103, false]
]

function Skeleton({ scale }: { scale: number }) {
  return (
    <View style={{ gap: 5 * scale, padding: 8 * scale }}>
      {LINES.map(([w, head], i) => (
        <View key={i} style={{ width: w * scale, height: 4 * scale, borderRadius: radius.full, backgroundColor: head ? palette.ink300 : palette.ink100 }} />
      ))}
    </View>
  )
}

/** Demo mode only: the sample pages are SVG (a real Mac sends JPEG). */
function isSvg(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x3c && data[1] === 0x73 && data[2] === 0x76 && data[3] === 0x67
}

/**
 * A page preview reassembled from `file.get` chunks and hash-checked; the Figma paper with
 * placeholder lines while it loads, its progress, or why it failed.
 */
export function PagePreview({ view, width = 160, height = 200, onPress, onRetry }: { view: FileView | undefined; width?: number; height?: number; onPress?: () => void; onRetry?: () => void }) {
  const colors = useColors()
  const data = view?.state === 'ready' ? view.data : undefined
  const source = useMemo((): { svg: string } | { uri: string } | null => {
    if (!data) return null
    if (DEMO && isSvg(data)) return { svg: utf8Text(data) }
    return { uri: `data:image/jpeg;base64,${toBase64(data)}` }
  }, [data])
  const scale = width / 160
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={view ? `${view.file}${view.state === 'ready' ? '' : `, ${view.state}`}` : 'Page preview'}
      disabled={!onPress && !(view?.state === 'failed' && onRetry)}
      onPress={view?.state === 'failed' ? onRetry : onPress}
      style={{ width, height, borderRadius: radius.xs, backgroundColor: '#ffffff', overflow: 'hidden' }}
    >
      {source && 'svg' in source ? (
        <SvgXml xml={source.svg} width={width} height={height} />
      ) : source ? (
        <Image source={{ uri: source.uri }} style={{ width, height }} resizeMode="contain" accessibilityIgnoresInvertColors />
      ) : (
        <Skeleton scale={scale} />
      )}
      {view && view.state !== 'ready' ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 6, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: view.state === 'failed' ? colors.dangerSoft : '#0b0f15cc' }}>
          {view.state === 'failed' ? <Icon name="alert-circle" size={12} color={colors.danger} /> : <ActivityIndicator size="small" color="#ffffff" style={{ width: 12, height: 12 }} />}
          <Txt variant="monoXs" style={{ flex: 1, color: view.state === 'failed' ? colors.danger : '#ffffff' }} numberOfLines={2}>
            {view.state === 'failed' ? 'Tap to retry' : view.of > 0 ? `${view.received}/${view.of}` : 'Waiting'}
          </Txt>
        </View>
      ) : null}
    </Pressable>
  )
}
