/**
 * Tabler outline icons, as in the Figma file (layers `icon/<name>`). Deep imports keep the
 * bundle to the icons used here instead of the whole set.
 */

import IconAlertCircle from '@tabler/icons-react-native/IconAlertCircle'
import IconAlertTriangle from '@tabler/icons-react-native/IconAlertTriangle'
import IconArrowsExchange from '@tabler/icons-react-native/IconArrowsExchange'
import IconBattery from '@tabler/icons-react-native/IconBattery'
import IconBolt from '@tabler/icons-react-native/IconBolt'
import IconBriefcase from '@tabler/icons-react-native/IconBriefcase'
import IconCamera from '@tabler/icons-react-native/IconCamera'
import IconCheck from '@tabler/icons-react-native/IconCheck'
import IconChevronDown from '@tabler/icons-react-native/IconChevronDown'
import IconChevronLeft from '@tabler/icons-react-native/IconChevronLeft'
import IconChevronRight from '@tabler/icons-react-native/IconChevronRight'
import IconCircleCheck from '@tabler/icons-react-native/IconCircleCheck'
import IconClipboard from '@tabler/icons-react-native/IconClipboard'
import IconClipboardCheck from '@tabler/icons-react-native/IconClipboardCheck'
import IconClock from '@tabler/icons-react-native/IconClock'
import IconCpu from '@tabler/icons-react-native/IconCpu'
import IconDeviceMobile from '@tabler/icons-react-native/IconDeviceMobile'
import IconExternalLink from '@tabler/icons-react-native/IconExternalLink'
import IconFile from '@tabler/icons-react-native/IconFile'
import IconFileText from '@tabler/icons-react-native/IconFileText'
import IconFilter from '@tabler/icons-react-native/IconFilter'
import IconFlagCheck from '@tabler/icons-react-native/IconFlagCheck'
import IconHome from '@tabler/icons-react-native/IconHome'
import IconHourglass from '@tabler/icons-react-native/IconHourglass'
import IconInfoCircle from '@tabler/icons-react-native/IconInfoCircle'
import IconLink from '@tabler/icons-react-native/IconLink'
import IconListCheck from '@tabler/icons-react-native/IconListCheck'
import IconLoader2 from '@tabler/icons-react-native/IconLoader2'
import IconMoon from '@tabler/icons-react-native/IconMoon'
import IconPhoto from '@tabler/icons-react-native/IconPhoto'
import IconPlayerPause from '@tabler/icons-react-native/IconPlayerPause'
import IconPlayerPlay from '@tabler/icons-react-native/IconPlayerPlay'
import IconPlayerStop from '@tabler/icons-react-native/IconPlayerStop'
import IconPlus from '@tabler/icons-react-native/IconPlus'
import IconQrcode from '@tabler/icons-react-native/IconQrcode'
import IconRefresh from '@tabler/icons-react-native/IconRefresh'
import IconSearch from '@tabler/icons-react-native/IconSearch'
import IconSend from '@tabler/icons-react-native/IconSend'
import IconSettings from '@tabler/icons-react-native/IconSettings'
import IconShare from '@tabler/icons-react-native/IconShare'
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
  'arrows-exchange': IconArrowsExchange,
  battery: IconBattery,
  bolt: IconBolt,
  briefcase: IconBriefcase,
  camera: IconCamera,
  check: IconCheck,
  'chevron-down': IconChevronDown,
  'chevron-left': IconChevronLeft,
  'chevron-right': IconChevronRight,
  'circle-check': IconCircleCheck,
  clipboard: IconClipboard,
  'clipboard-check': IconClipboardCheck,
  clock: IconClock,
  cpu: IconCpu,
  'device-mobile': IconDeviceMobile,
  'external-link': IconExternalLink,
  file: IconFile,
  'file-text': IconFileText,
  filter: IconFilter,
  'flag-check': IconFlagCheck,
  home: IconHome,
  hourglass: IconHourglass,
  'info-circle': IconInfoCircle,
  link: IconLink,
  'list-check': IconListCheck,
  loader: IconLoader2,
  moon: IconMoon,
  pause: IconPlayerPause,
  photo: IconPhoto,
  play: IconPlayerPlay,
  plus: IconPlus,
  qrcode: IconQrcode,
  refresh: IconRefresh,
  search: IconSearch,
  send: IconSend,
  settings: IconSettings,
  share: IconShare,
  'shield-check': IconShieldCheck,
  sparkles: IconSparkles,
  stop: IconPlayerStop,
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
