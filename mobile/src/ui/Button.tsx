import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import { Icon, type IconName } from './Icon'
import { emberGlow, radius, type, useColors, type Colors } from './theme'
import { Txt } from './Txt'

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'secondary'
export type ButtonSize = 'sm' | 'md' | 'lg'

function variantStyle(colors: Colors, variant: ButtonVariant): { bg?: string; border?: string; fg: string } {
  switch (variant) {
    case 'primary':
      return { bg: colors.accentPrimary, fg: colors.textOnAccent }
    case 'outline':
      return { border: colors.borderDefault, fg: colors.textPrimary }
    case 'danger':
      return { bg: colors.dangerSoft, fg: colors.danger }
    case 'secondary':
      return { bg: colors.bgSubtle, fg: colors.textPrimary }
    default:
      return { fg: colors.textSecondary }
  }
}

const SIZES = {
  sm: { px: 10, py: 6, icon: 14, iconStroke: 2, text: type.labelSm },
  md: { px: 14, py: 9, icon: 16, iconStroke: 2, text: type.labelMd },
  lg: { px: 20, py: 13, icon: 16, iconStroke: 2, text: type.headingSm }
} as const

export interface ButtonProps {
  label: string
  onPress?: () => void
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  disabled?: boolean
  busy?: boolean
  /** Stretch to the row (flex: 1) or the parent's width. */
  grow?: boolean
  style?: StyleProp<ViewStyle>
}

/** Button/primary|outline|ghost|danger|secondary × sm|md|lg from the Figma components. */
export function Button({ label, onPress, variant = 'primary', size = 'sm', icon, disabled, busy, grow, style }: ButtonProps) {
  const colors = useColors()
  const v = variantStyle(colors, variant)
  const s = SIZES[size]
  const border = v.border ? 1 : 0
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingHorizontal: s.px - border,
          paddingVertical: s.py - border,
          borderRadius: radius.md,
          backgroundColor: v.bg,
          borderWidth: border,
          borderColor: v.border
        },
        grow && { flexGrow: 1, flexBasis: 0 },
        variant === 'primary' && size === 'lg' && !disabled && emberGlow(colors),
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] },
        style
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={v.fg} style={{ width: s.icon, height: s.icon }} /> : icon ? <Icon name={icon} size={s.icon} color={v.fg} stroke={s.iconStroke} /> : null}
      <Txt style={[s.text, { color: v.fg }]} numberOfLines={1}>
        {label}
      </Txt>
    </Pressable>
  )
}

export interface IconButtonProps {
  icon: IconName
  label: string
  onPress?: () => void
  variant?: 'outline' | 'primary'
  disabled?: boolean
}

/** IconButton/x|trash (outline, 14 px icon, 6 px padding) and IconButton/send (primary, 16 px, 10 px). */
export function IconButton({ icon, label, onPress, variant = 'outline', disabled }: IconButtonProps) {
  const colors = useColors()
  const primary = variant === 'primary'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        {
          padding: primary ? 10 : 5,
          borderRadius: radius.md,
          borderWidth: primary ? 0 : 1,
          borderColor: colors.borderDefault,
          backgroundColor: primary ? colors.accentPrimary : undefined,
          alignSelf: 'flex-start'
        },
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.8, transform: [{ scale: 0.95 }] }
      ]}
    >
      <View>
        <Icon name={icon} size={primary ? 16 : 14} color={primary ? colors.textOnAccent : colors.textPrimary} stroke={2} />
      </View>
    </Pressable>
  )
}
