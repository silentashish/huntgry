import { Text, type TextProps } from 'react-native'
import { type, useColors, type Colors, type TypeName } from './theme'

export type ColorName = keyof Colors

export interface TxtProps extends TextProps {
  variant?: TypeName
  color?: ColorName
  align?: 'left' | 'center' | 'right'
}

/** Text in one of the Figma text styles and a semantic colour. */
export function Txt({ variant = 'bodySm', color = 'textPrimary', align, style, ...rest }: TxtProps) {
  const colors = useColors()
  return <Text {...rest} style={[type[variant], { color: colors[color] }, align ? { textAlign: align } : null, style]} />
}
