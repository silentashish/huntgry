import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppShell } from '@mantine/core'
import type { MasterProfile } from '@shared/master-profile'
import {
  DEFAULT_LOCATION,
  FULL_BLEED,
  NavigationContext,
  WIDE,
  locationOf,
  redirect,
  type Location,
  type NavPage,
  type Navigation
} from '../../navigation'
import { useThemePreference } from '../../theme'
import { CommandPalette, MOD_LABEL } from '../palette/CommandPalette'
import { ConfirmModal } from '../profile/ConfirmModal'
import { Sidebar } from './Sidebar'
import classes from './shell.module.css'

interface Props {
  workspacePath: string
  /** Page to open first; the dashboard by default. */
  initialLocation?: Location
  /** The master profile on screen, searched by the ⌘K palette. */
  profile?: MasterProfile | null
  onSwitchWorkspace(): void
  /** Renders the current page. */
  children(location: Location): ReactNode
}

const IS_MAC = MOD_LABEL === '⌘'

/** ⌘ on macOS, Ctrl elsewhere, with no other modifier than `shift` when asked. (Ctrl+K edits text on macOS.) */
function isMod(e: KeyboardEvent, key: string, shift = false): boolean {
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && e.shiftKey === shift && e.key.toLowerCase() === key
}

/**
 * The shell around every page once a workspace is open: the sidebar, the ⌘K palette, and the navigation
 * context with its unsaved-changes guard.
 */
export function AppLayout({ workspacePath, initialLocation, profile = null, onSwitchWorkspace, children }: Props) {
  const [location, setLocation] = useState<Location>(() => redirect(initialLocation ?? DEFAULT_LOCATION))
  const guard = useRef<string | null>(null)
  const [pending, setPending] = useState<{ message: string; proceed(): void } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { resolved, setPreference } = useThemePreference()
  const main = useRef<HTMLElement>(null)

  /** Runs `action` now, or after the user confirms leaving unsaved work. */
  const guarded = useCallback((action: () => void) => {
    if (guard.current === null) return action()
    setPending({
      message: guard.current,
      proceed: () => {
        guard.current = null
        setPending(null)
        action()
      }
    })
  }, [])

  const setLeaveGuard = useCallback((message: string | null) => {
    guard.current = message
  }, [])

  const nav = useMemo<Navigation>(
    () => ({
      location,
      navigate: (page, ...params) => guarded(() => setLocation(locationOf(page, ...(params as [never])))),
      setLeaveGuard
    }),
    [location, guarded, setLeaveGuard]
  )

  // ⌘K / Ctrl+K opens (or closes) the palette on every page; ⌘⇧L switches the theme. Keys typed inside
  // the in-app browser's pages never reach this window, so its own shortcuts are untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      if (isMod(e, 'k')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (isMod(e, 'l', true)) {
        e.preventDefault()
        setPreference(resolved === 'dark' ? 'light' : 'dark')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resolved, setPreference])

  // "Settings → Pricing" from the palette: bring that card (`data-settings-section`, #116) into view once
  // the page has drawn it (the cards appear after the environment check).
  const section = location.page === 'settings' ? location.params?.section : undefined
  useEffect(() => {
    if (!section) return
    let frames = 0
    let raf = 0
    const find = () => {
      const el = main.current?.querySelector(`[data-settings-section="${section}"]`)
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      else if (++frames < 120) raf = requestAnimationFrame(find)
    }
    raf = requestAnimationFrame(find)
    return () => cancelAnimationFrame(raf)
  }, [section, location])

  const fullBleed = FULL_BLEED.has(location.page)
  const current = location.page === 'graph' ? null : (location.page as NavPage)

  return (
    <NavigationContext.Provider value={nav}>
      <AppShell navbar={{ width: 240, breakpoint: 0 }} padding={fullBleed ? 0 : 'xl'}>
        <AppShell.Navbar className={classes.navbar}>
          <Sidebar
            current={current}
            onNavigate={(page) => nav.navigate(page)}
            onOpenPipeline={() => nav.navigate('tailor', { view: 'queue' })}
            onOpenPalette={() => setPaletteOpen(true)}
            mod={MOD_LABEL}
            workspacePath={workspacePath}
            onSwitchWorkspace={() => guarded(onSwitchWorkspace)}
          />
        </AppShell.Navbar>

        <AppShell.Main ref={main}>
          {fullBleed || WIDE.has(location.page) ? (
            children(location)
          ) : (
            <div className={classes.content}>{children(location)}</div>
          )}
        </AppShell.Main>
      </AppShell>

      <CommandPalette
        opened={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        profile={profile}
        onSwitchWorkspace={onSwitchWorkspace}
        guarded={guarded}
      />

      {/* The leave guard (Figma 17:1030), the same question the Profile page asks itself. */}
      <ConfirmModal
        opened={pending !== null}
        title="Discard unsaved changes?"
        cancelLabel="Keep editing"
        confirmLabel="Discard and leave"
        onCancel={() => setPending(null)}
        onConfirm={() => pending?.proceed()}
      >
        {pending?.message}
      </ConfirmModal>
    </NavigationContext.Provider>
  )
}
