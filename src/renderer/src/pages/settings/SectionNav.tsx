import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { UnstyledButton } from '@mantine/core'
import {
  IconCpu,
  IconCurrencyDollar,
  IconDeviceMobile,
  IconListCheck,
  IconLock,
  IconShieldCheck,
  IconSun,
  IconTerminal2
} from '@tabler/icons-react'
import classes from './settings.module.css'

/** The cards of the Settings page, in page order (Figma "Settings" section nav). */
export type SettingsSectionId =
  | 'agents'
  | 'approvals'
  | 'answers'
  | 'pricing'
  | 'claude'
  | 'deps'
  | 'remote'
  | 'appearance'

export const SETTINGS_SECTIONS: readonly {
  id: SettingsSectionId
  label: string
  icon: ComponentType<{ size?: number; stroke?: number }>
}[] = [
  { id: 'agents', label: 'Agents', icon: IconCpu },
  { id: 'approvals', label: 'Standing approvals', icon: IconShieldCheck },
  { id: 'answers', label: 'Saved answers', icon: IconLock },
  { id: 'pricing', label: 'Pricing', icon: IconCurrencyDollar },
  { id: 'claude', label: 'Claude', icon: IconTerminal2 },
  { id: 'deps', label: 'Skill dependencies', icon: IconListCheck },
  { id: 'remote', label: 'Remote control', icon: IconDeviceMobile },
  { id: 'appearance', label: 'Appearance', icon: IconSun }
]

/** The DOM id of a section's wrapper. */
export const sectionDomId = (id: SettingsSectionId): string => `settings-${id}`

/** Distance from the top of the viewport at which a section counts as the one being read. */
const READ_LINE = 140

/**
 * The section to highlight: the last one whose top has passed `line` (px from the viewport top),
 * the first one before any has, and the last one once the page is scrolled to the bottom (a short
 * last card never reaches the line). `tops` follow `ids`; `null` is a section not on screen.
 */
export function activeSection<T extends string>(
  ids: readonly T[],
  tops: readonly (number | null)[],
  line: number,
  atBottom: boolean
): T | null {
  const present = ids.filter((_, i) => tops[i] !== null)
  if (present.length === 0) return null
  if (atBottom) return present[present.length - 1]
  let active = present[0]
  ids.forEach((id, i) => {
    const top = tops[i]
    if (top !== null && top <= line) active = id
  })
  return active
}

function scrolledToBottom(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : document.scrollingElement
  if (!el) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight < 2
}

/** One card of the page: the anchor the nav scrolls to and watches. */
export function SettingsSection({ id, children }: { id: SettingsSectionId; children: ReactNode }) {
  return (
    <div id={sectionDomId(id)} className={classes.section} data-settings-section={id}>
      {children}
    </div>
  )
}

/**
 * The sticky list of sections on the left: a click scrolls to the card, and the card being read is
 * highlighted while the page scrolls (whichever element scrolls: the window or the shell's main).
 */
export function SectionNav({ sections }: { sections: readonly SettingsSectionId[] }) {
  const [active, setActive] = useState<SettingsSectionId | null>(sections[0] ?? null)
  /** While a click's smooth scroll runs (and until it stops), the clicked entry stays highlighted. */
  const pinnedUntil = useRef(0)
  const key = sections.join(',')

  useEffect(() => {
    let frame = 0
    const update = (target: EventTarget | null) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (Date.now() < pinnedUntil.current) return
        const tops = sections.map(
          (id) => document.getElementById(sectionDomId(id))?.getBoundingClientRect().top ?? null
        )
        const next = activeSection(sections, tops, READ_LINE, scrolledToBottom(target))
        if (next) setActive(next)
      })
    }
    const onScroll = (e: Event) => {
      // A click's smooth scroll keeps its entry highlighted until the scrolling stops, even when the
      // page cannot bring that card up to the reading line (the last cards).
      const now = Date.now()
      if (now < pinnedUntil.current) {
        pinnedUntil.current = Math.max(pinnedUntil.current, now + 250)
        return
      }
      update(e.target === document ? null : e.target)
    }
    const onResize = () => update(null)
    // Scroll events do not bubble: listen in the capture phase to see the shell's scroller too.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    update(null)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onResize)
    }
    // `key` stands for `sections` (a new array on every render of the page).
  }, [key])

  function go(id: SettingsSectionId) {
    setActive(id)
    pinnedUntil.current = Date.now() + 700
    document.getElementById(sectionDomId(id))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  // Not a <nav>: the shell's navbar is the page's one navigation landmark (e2e finds it by that role).
  return (
    <aside className={classes.nav} aria-label="Settings sections">
      {SETTINGS_SECTIONS.filter((s) => sections.includes(s.id)).map(({ id, label, icon: Icon }) => (
        <UnstyledButton
          key={id}
          className={classes.navItem}
          data-active={active === id || undefined}
          aria-current={active === id ? 'true' : undefined}
          onClick={() => go(id)}
        >
          <Icon size={16} stroke={1.75} />
          <span>{label}</span>
        </UnstyledButton>
      ))}
    </aside>
  )
}
