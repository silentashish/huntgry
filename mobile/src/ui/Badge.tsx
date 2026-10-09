import { View } from 'react-native'
import { PulseDot } from './PulseDot'
import { radius, type, useColors, type Colors } from './theme'
import { Txt } from './Txt'

export type Tone = 'neutral' | 'warning' | 'info' | 'success' | 'danger' | 'trail' | 'ember' | 'review'

export function toneColors(colors: Colors, tone: Tone): { fg: string; bg: string; dot: string } {
  switch (tone) {
    case 'warning':
      return { fg: colors.warning, bg: colors.warningSoft, dot: colors.warning }
    case 'info':
      return { fg: colors.info, bg: colors.infoSoft, dot: colors.info }
    case 'success':
      return { fg: colors.success, bg: colors.successSoft, dot: colors.success }
    case 'danger':
      return { fg: colors.danger, bg: colors.dangerSoft, dot: colors.danger }
    case 'trail':
      return { fg: colors.accentSecondary, bg: colors.accentSecondarySoft, dot: colors.accentSecondary }
    case 'ember':
      return { fg: colors.textAccent, bg: colors.accentPrimarySoft, dot: colors.accentPrimary }
    case 'review':
      return { fg: colors.review, bg: colors.reviewSoft, dot: colors.review }
    default:
      return { fg: colors.textSecondary, bg: colors.bgSubtle, dot: colors.textSecondary }
  }
}

export interface BadgeProps {
  label: string
  tone?: Tone
  /** `soft`: tinted fill; `outline`: a 1 px ring (agent badges). */
  variant?: 'soft' | 'outline'
  dot?: boolean
  live?: boolean
  /** `sm` (queue cards), `md` (card headers), `lg` (the Mac presence pill). */
  size?: 'sm' | 'md' | 'lg'
}

const PADDING = { sm: { paddingHorizontal: 6, paddingVertical: 0, gap: 5 }, md: { paddingHorizontal: 8, paddingVertical: 2, gap: 5 }, lg: { paddingHorizontal: 10, paddingVertical: 4, gap: 6 } }

export function Badge({ label, tone = 'neutral', variant = 'soft', dot = false, live = false, size = 'sm' }: BadgeProps) {
  const colors = useColors()
  const c = toneColors(colors, tone)
  const outlineColor = tone === 'ember' ? colors.accentPrimary : c.fg
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', borderRadius: radius.full, alignSelf: 'flex-start', ...PADDING[size] },
        variant === 'soft' ? { backgroundColor: c.bg } : { borderWidth: 1, borderColor: outlineColor, paddingHorizontal: PADDING[size].paddingHorizontal - 1 }
      ]}
    >
      {dot && <PulseDot color={c.dot} live={live} />}
      <Txt variant="labelSm" style={[type.labelSm, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Txt>
    </View>
  )
}
