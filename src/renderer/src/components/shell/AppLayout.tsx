import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppShell, Button, Group, Image, Modal, NavLink, ScrollArea, Stack, Text, Title, Tooltip } from '@mantine/core'
import {
  IconBriefcase,
  IconChartDots3,
  IconEyeCheck,
  IconFileText,
  IconLayoutDashboard,
  IconSettings,
  IconSparkles,
  IconSwitchHorizontal,
  IconWorld,
  type Icon
} from '@tabler/icons-react'
import logo from '../../assets/logo.svg'
import {
  DEFAULT_LOCATION,
  FULL_BLEED,
  NavigationContext,
  PAGES,
  locationOf,
  type Location,
  type Navigation,
  type Page
} from '../../navigation'

const NAV: Record<Page, { label: string; icon: Icon; hint: string }> = {
  dashboard: { label: 'Dashboard', icon: IconLayoutDashboard, hint: 'Generated resumes and applications' },
  jobs: { label: 'Jobs', icon: IconBriefcase, hint: 'Jobs added by URL or pasted' },
  browser: { label: 'Browser', icon: IconWorld, hint: 'Open job postings without leaving the app' },
  tailor: { label: 'Tailor', icon: IconSparkles, hint: 'Run the resume-tailor skill with Claude, Codex or Antigravity' },
  review: { label: 'Review', icon: IconEyeCheck, hint: 'Approve, re-run or discard unattended results' },
  graph: { label: 'Knowledge graph', icon: IconChartDots3, hint: 'Your skills and experience as a graph' },
  profile: { label: 'Master profile', icon: IconFileText, hint: 'The single source of truth for every resume' },
  settings: { label: 'Settings', icon: IconSettings, hint: 'Agent CLIs, skill and dependencies' }
}

interface Props {
  workspacePath: string
  /** Page to open first; the dashboard by default. */
  initialLocation?: Location
  onSwitchWorkspace(): void
  /** Renders the current page. */
  children(location: Location): ReactNode
}

/**
 * The shell around every page once a workspace is open: navbar, workspace
 * path, and the navigation context with its unsaved-changes guard.
 */
export function AppLayout({ workspacePath, initialLocation, onSwitchWorkspace, children }: Props) {
  const [location, setLocation] = useState<Location>(initialLocation ?? DEFAULT_LOCATION)
  const guard = useRef<string | null>(null)
  const [pending, setPending] = useState<{ message: string; proceed(): void } | null>(null)

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

  const fullBleed = FULL_BLEED.has(location.page)

  return (
    <NavigationContext.Provider value={nav}>
      <AppShell navbar={{ width: 240, breakpoint: 0 }} padding={fullBleed ? 0 : 'lg'}>
        <AppShell.Navbar p="sm">
          <AppShell.Section>
            <Group gap="xs" wrap="nowrap" px="xs" py="sm">
              <Image src={logo} alt="" w={32} h={32} />
              <Title order={3} lh={1}>
                Huntgry
              </Title>
            </Group>
          </AppShell.Section>
          <AppShell.Section grow component={ScrollArea} mt="xs">
            {PAGES.map((page) => {
              const { label, icon: PageIcon, hint } = NAV[page]
              return (
                <NavLink
                  key={page}
                  // A button, not an anchor without href: focusable, and named "<label> <hint>" for assistive tech and tests.
                  component="button"
                  type="button"
                  label={label}
                  description={hint}
                  leftSection={<PageIcon size={20} stroke={1.6} />}
                  active={location.page === page}
                  aria-current={location.page === page ? 'page' : undefined}
                  onClick={() => nav.navigate(page)}
                  styles={{ description: { fontSize: 'var(--mantine-font-size-xs)' } }}
                  style={{ borderRadius: 'var(--mantine-radius-md)' }}
                />
              )
            })}
          </AppShell.Section>
          <AppShell.Section>
            <Stack gap={4} p="xs">
              <Text size="xs" c="dimmed">
                Workspace
              </Text>
              <Tooltip label={workspacePath} multiline maw={360} openDelay={400}>
                <Text size="xs" ff="monospace" truncate="start">
                  <bdi>{workspacePath}</bdi>
                </Text>
              </Tooltip>
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconSwitchHorizontal size={14} />}
                onClick={() => guarded(onSwitchWorkspace)}
                justify="flex-start"
                px={0}
              >
                Switch workspace
              </Button>
            </Stack>
          </AppShell.Section>
        </AppShell.Navbar>

        <AppShell.Main>
          {fullBleed ? (
            children(location)
          ) : (
            <div style={{ maxWidth: 1040, margin: '0 auto' }}>{children(location)}</div>
          )}
        </AppShell.Main>
      </AppShell>

      <Modal opened={pending !== null} onClose={() => setPending(null)} title="Discard unsaved changes?" centered>
        <Stack gap="sm">
          <Text size="sm">{pending?.message}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPending(null)}>
              Keep editing
            </Button>
            <Button color="red" onClick={() => pending?.proceed()}>
              Discard and leave
            </Button>
          </Group>
        </Stack>
      </Modal>
    </NavigationContext.Provider>
  )
}
