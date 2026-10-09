import type { ReactNode } from 'react'
import { View } from 'react-native'
import { toneColors } from './Badge'
import { Icon, type IconName } from './Icon'
import { radius, useColors } from './theme'
import { Txt } from './Txt'

/** Alert/warning and Alert/info: soft fill, 18 px icon, title in the tone, body secondary. */
export function Alert({ tone, title, children, icon }: { tone: 'warning' | 'info' | 'danger'; title?: string; children: ReactNode; icon?: IconName }) {
  const colors = useColors()
  const c = toneColors(colors, tone)
  return (
    <View style={{ flexDirection: 'row', gap: 12, padding: 14, borderRadius: radius.lg, backgroundColor: c.bg, alignItems: 'flex-start' }}>
      <Icon name={icon ?? (tone === 'info' ? 'info-circle' : 'alert-triangle')} size={18} color={c.fg} />
      <View style={{ flex: 1, gap: 4 }}>
        {title ? (
          <Txt variant="headingSm" style={{ color: c.fg }}>
            {title}
          </Txt>
        ) : null}
        <Txt variant="bodySm" color="textSecondary">
          {children}
        </Txt>
      </View>
    </View>
  )
}
