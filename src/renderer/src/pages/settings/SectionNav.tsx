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

/**
 * The cards of the Settings page, in page order (Figma "Settings" section nav). The ids are the
 * shell's `SettingsSection` (navigation.ts): the ⌘K palette finds a card by `data-settings-section`.
 */
export type SettingsSectionId =
  | 'agents'
  | 'standing-approvals'
  | 'saved-answers'
  | 'pricing'
  | 'claude'
  | 'skill-dependencies'
  | 'remote-control'
  | 'appearance'

export const SETTINGS_SECTIONS: readonly {
  id: SettingsSectionId
  label: string
  icon: ComponentType<{ size?: number; stroke?: number }>
}[] = [
  { id: 'agents', label: 'Agents', icon: IconCpu },
  { id: 'standing-approvals', label: 'Standing approvals', icon: IconShieldCheck },
  { id: 'saved-answers', label: 'Saved answers', icon: IconLock },
  { id: 'pricing', label: 'Pricing', icon: IconCurrencyDollar },
  { id: 'claude', label: 'Claude', icon: IconTerminal2 },
  { id: 'skill-dependencies', label: 'Skill dependencies', icon: IconListCheck },
  { id: 'remote-control', label: 'Remote control', icon: IconDeviceMobile },
  { id: 'appearance', label: 'Appearance', icon: IconSun }
]

/** The DOM id of a section's wrapper. */
export const sectionDomId = (id: SettingsSectionId): string => `settings-${id}`

/** Distance from the top of the viewport at which a section counts as the one being read. */
const READ_LINE = 140

/**
 * The section to highlight: the last one whose top has passed `line` (px from the viewport top),
 * the first one before any has, and the last one once the page is scrolled to the bottom (a short
 * last card never reaches the line). Cards side by side share a top: the first of them wins.
 * `tops` follow `ids` in page order; `null` is a section not on screen.
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
  let active: T | null = null
  let activeTop = -Infinity
  ids.forEach((id, i) => {
    const top = tops[i]
    if (top !== null && top <= line && (active === null || top > activeTop)) {
      active = id
      activeTop = top
    }
  })
  return active ?? present[0]
}

/** The element that scrolls `el`: its nearest scrollable ancestor, or the document. */
function scrollerOf(el: Element): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return document.scrollingElement
}

/** Scrolled to the end; a page that does not scroll at all is not "at the bottom". */
function atEnd(scroller: Element | null): boolean {
  if (!scroller || scroller.scrollHeight - scroller.clientHeight < 2) return false
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2
}

/** The first section wrapper on the page, if any is rendered. */
function firstSection(sections: readonly SettingsSectionId[]): HTMLElement | null {
  for (const id of sections) {
    const el = document.getElementById(sectionDomId(id))
    if (el) return el
  }
  return null
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
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (Date.now() < pinnedUntil.current) return
        const first = firstSection(sections)
        if (!first) return
        const tops = sections.map(
          (id) => document.getElementById(sectionDomId(id))?.getBoundingClientRect().top ?? null
        )
        const next = activeSection(sections, tops, READ_LINE, atEnd(scrollerOf(first)))
        if (next) setActive(next)
      })
    }
    const onScroll = (e: Event) => {
      // Only scrolls that move the cards count: not the install log, a table, the audit log or a dropdown.
      if (e.target instanceof Element) {
        const first = firstSection(sections)
        if (!first || !e.target.contains(first)) return
      }
      // A click's smooth scroll keeps its entry highlighted until the scrolling stops, even when the
      // page cannot bring that card up to the reading line (the last cards).
      const now = Date.now()
      if (now < pinnedUntil.current) {
        pinnedUntil.current = Math.max(pinnedUntil.current, now + 250)
        return
      }
      update()
    }
    // Scroll events do not bubble: listen in the capture phase to see the shell's scroller too.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', update)
    update()
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', update)
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
