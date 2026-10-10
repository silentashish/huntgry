/**
 * Small controls the #40 / #41 / #42 screens share: the Figma Checkbox (16 pt, radius xs), the
 * Input (sunken, 1 pt border, icon), chips for a one-of choice, and a destructive button that
 * asks for a second tap instead of a dialog (React Native's Alert does nothing on the web).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Pressable, TextInput, View, type TextInputProps } from 'react-native'
import { Button, type ButtonProps } from './Button'
import { Icon, type IconName } from './Icon'
import { radius, type, useColors } from './theme'
import { Txt } from './Txt'

export function Checkbox({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  const colors = useColors()
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: radius.xs,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: checked ? colors.accentPrimary : colors.bgSurface,
        borderWidth: checked ? 0 : 1,
        borderColor: colors.borderStrong,
        opacity: disabled ? 0.45 : 1
      }}
    >
      {checked ? <Icon name="check" size={11} color={colors.textOnAccent} stroke={2.5} /> : null}
    </View>
  )
}

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  icon?: IconName
  right?: ReactNode
}

/** Input from the Figma file: sunken fill, default border, radius md, 12 / 9 padding, a 16 pt icon. */
export function Field({ icon, right, ...input }: FieldProps) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 11, paddingRight: right ? 5 : 11, minHeight: 38, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurfaceSunken }}>
      {icon ? <Icon name={icon} size={16} color={colors.textMuted} /> : null}
      <TextInput placeholderTextColor={colors.textMuted} {...input} style={[type.bodySm, { flex: 1, color: colors.textPrimary, paddingVertical: 8, outlineStyle: 'none' } as object]} />
      {right}
    </View>
  )
}

/** One-of choice as a row of pills (agents, concurrency). */
export function Chips<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void; label: string }) {
  const colors = useColors()
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: o.disabled }}
            disabled={o.disabled}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => ({
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: radius.full,
              borderWidth: 1,
              borderColor: on ? colors.accentPrimary : colors.borderDefault,
              backgroundColor: on ? colors.accentPrimarySoft : 'transparent',
              opacity: o.disabled ? 0.4 : pressed ? 0.8 : 1
            })}
          >
            <Txt variant="labelMd" color={on ? 'textAccent' : 'textPrimary'}>
              {o.label}
            </Txt>
          </Pressable>
        )
      })}
    </View>
  )
}

/** A destructive action: the first tap arms it ("Tap again to …"), the second within 4 s runs it. */
export function ConfirmButton({ label, confirmLabel, onConfirm, ...rest }: Omit<ButtonProps, 'onPress'> & { confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  return (
    <Button
      {...rest}
      label={armed ? confirmLabel : label}
      onPress={() => {
        if (timer.current) clearTimeout(timer.current)
        if (armed) {
          setArmed(false)
          onConfirm()
          return
        }
        setArmed(true)
        timer.current = setTimeout(() => setArmed(false), 4000)
      }}
    />
  )
}

/** A mono section label ("Reframings the run left out"). */
export function SectionLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Txt variant="monoSm" color="textMuted" style={{ flex: 1 }}>
        {children}
      </Txt>
      {right}
    </View>
  )
}
