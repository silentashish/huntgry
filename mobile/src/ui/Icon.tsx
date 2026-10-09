/**
 * Tabler outline icons, as in the Figma file (layers `icon/<name>`). Deep imports keep the
 * bundle to the icons used here instead of the whole set.
 */

import IconAlertCircle from '@tabler/icons-react-native/IconAlertCircle'
import IconAlertTriangle from '@tabler/icons-react-native/IconAlertTriangle'
import IconBattery from '@tabler/icons-react-native/IconBattery'
import IconBolt from '@tabler/icons-react-native/IconBolt'
import IconBriefcase from '@tabler/icons-react-native/IconBriefcase'
import IconCamera from '@tabler/icons-react-native/IconCamera'
import IconCheck from '@tabler/icons-react-native/IconCheck'
import IconChevronLeft from '@tabler/icons-react-native/IconChevronLeft'
import IconChevronRight from '@tabler/icons-react-native/IconChevronRight'
import IconCircleCheck from '@tabler/icons-react-native/IconCircleCheck'
import IconClipboard from '@tabler/icons-react-native/IconClipboard'
import IconClipboardCheck from '@tabler/icons-react-native/IconClipboardCheck'
import IconCpu from '@tabler/icons-react-native/IconCpu'
import IconDeviceMobile from '@tabler/icons-react-native/IconDeviceMobile'
import IconFlagCheck from '@tabler/icons-react-native/IconFlagCheck'
import IconHome from '@tabler/icons-react-native/IconHome'
import IconInfoCircle from '@tabler/icons-react-native/IconInfoCircle'
import IconListCheck from '@tabler/icons-react-native/IconListCheck'
import IconLoader2 from '@tabler/icons-react-native/IconLoader2'
import IconPlayerPause from '@tabler/icons-react-native/IconPlayerPause'
import IconPlayerPlay from '@tabler/icons-react-native/IconPlayerPlay'
import IconPlayerStop from '@tabler/icons-react-native/IconPlayerStop'
import IconPlus from '@tabler/icons-react-native/IconPlus'
import IconQrcode from '@tabler/icons-react-native/IconQrcode'
import IconRefresh from '@tabler/icons-react-native/IconRefresh'
import IconSend from '@tabler/icons-react-native/IconSend'
import IconSettings from '@tabler/icons-react-native/IconSettings'
import IconShieldCheck from '@tabler/icons-react-native/IconShieldCheck'
import IconSparkles from '@tabler/icons-react-native/IconSparkles'
import IconTerminal from '@tabler/icons-react-native/IconTerminal'
import IconTool from '@tabler/icons-react-native/IconTool'
import IconTrash from '@tabler/icons-react-native/IconTrash'
import IconWifi from '@tabler/icons-react-native/IconWifi'
import IconWifiOff from '@tabler/icons-react-native/IconWifiOff'
import IconX from '@tabler/icons-react-native/IconX'
import type { ComponentType } from 'react'

const ICONS = {
  'alert-circle': IconAlertCircle,
  'alert-triangle': IconAlertTriangle,
  battery: IconBattery,
  bolt: IconBolt,
  briefcase: IconBriefcase,
  camera: IconCamera,
  check: IconCheck,
  'chevron-left': IconChevronLeft,
  'chevron-right': IconChevronRight,
  'circle-check': IconCircleCheck,
  clipboard: IconClipboard,
  'clipboard-check': IconClipboardCheck,
  cpu: IconCpu,
  'device-mobile': IconDeviceMobile,
  'flag-check': IconFlagCheck,
  home: IconHome,
  'info-circle': IconInfoCircle,
  'list-check': IconListCheck,
  loader: IconLoader2,
  pause: IconPlayerPause,
  play: IconPlayerPlay,
  stop: IconPlayerStop,
  plus: IconPlus,
  qrcode: IconQrcode,
  refresh: IconRefresh,
  send: IconSend,
  settings: IconSettings,
  'shield-check': IconShieldCheck,
  sparkles: IconSparkles,
  terminal: IconTerminal,
  tool: IconTool,
  trash: IconTrash,
  wifi: IconWifi,
  'wifi-off': IconWifiOff,
  x: IconX
} satisfies Record<string, ComponentType<{ size?: number; color?: string; strokeWidth?: number }>>

export type IconName = keyof typeof ICONS

/**
 * `stroke` is the stroke in points as Figma shows it (1.75 for most icons, 2 for the small
 * ones in buttons); Tabler draws on a 24-unit grid, so it is scaled to the icon size.
 */
export function Icon({ name, size = 16, color, stroke = 1.75 }: { name: IconName; size?: number; color: string; stroke?: number }) {
  const Component = ICONS[name]
  return <Component size={size} color={color} strokeWidth={(stroke * 24) / size} />
}
