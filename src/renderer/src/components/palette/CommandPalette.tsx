import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Alert, Group, Kbd, Modal, Text } from '@mantine/core'
import {
  IconBriefcase,
  IconChartDots3,
  IconClipboardCheck,
  IconClipboardText,
  IconCompass,
  IconFileText,
  IconFlame,
  IconFolder,
  IconFolderOpen,
  IconLayoutDashboard,
  IconLayoutKanban,
  IconListCheck,
  IconListDetails,
  IconMoon,
  IconRobot,
  IconSearch,
  IconSend,
  IconSettings,
  IconSparkles,
  IconSun,
  IconSwitchHorizontal,
  IconUser,
  IconUserCircle,
  IconWorld,
  type Icon
} from '@tabler/icons-react'
import type { MasterProfile } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { useNavigation } from '../../navigation'
import { AddJobModal } from '../../pages/jobs/AddJobModal'
import { prepareTailor } from '../../pages/jobs/handoff'
import { tailorPrefillFor } from '@shared/jobs-types'
import { useThemePreference } from '../../theme'
import { useApply } from '../apply/useApply'
import { flatten, paletteItems, searchPalette, type PaletteCommand, type PaletteIcon, type PaletteItem } from './search'
import { usePaletteData } from './usePaletteData'
import classes from './palette.module.css'

const ICONS: Record<PaletteIcon, Icon> = {
  dashboard: IconLayoutDashboard,
  board: IconLayoutKanban,
  jobs: IconBriefcase,
  browser: IconWorld,
  tailor: IconSparkles,
  review: IconClipboardCheck,
  automation: IconRobot,
  profile: IconUser,
  settings: IconSettings,
  graph: IconChartDots3,
  skills: IconListDetails,
  discover: IconCompass,
  queue: IconListCheck,
  job: IconBriefcase,
  application: IconFileText,
  run: IconRobot,
  person: IconUserCircle,
  project: IconFolder,
  world: IconWorld,
  apply: IconSend,
  file: IconFileText,
  folder: IconFolderOpen,
  paste: IconClipboardText,
  theme: IconMoon,
  workspace: IconSwitchHorizontal,
  'settings-section': IconSettings
}

/** `⌘` on macOS, `Ctrl` elsewhere: how the shortcuts are written. */
export const MOD_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'

interface Props {
  opened: boolean
  onClose(): void
  /** The master profile on screen, searched for roles, projects and skills. */
  profile: MasterProfile | null
  onSwitchWorkspace(): void
  /**
   * The shell's unsaved-changes guard: runs `action` now, or once the user agrees to leave. Commands that
   * leave the page run inside it, so nothing (marking a job tailored, starting Apply) happens on "Keep editing".
   */
  guarded(action: () => void): void
}

/**
 * "Sniff", the ⌘K command palette (#108, Figma 17:352): jump to a page, job, application, run, profile entry
 * or Settings section, and run actions (Tailor, Open posting, Apply, Add job, Switch theme). Arrow keys
 * move, Enter opens, Tab jumps to the next group, Escape closes; focus stays inside while it is open.
 */
export function CommandPalette({ opened, onClose, profile, onSwitchWorkspace, guarded }: Props) {
  const { navigate, location } = useNavigation()
  const { resolved, setPreference } = useThemePreference()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { apply, confirmOpen, modal: applyModal } = useApply(setError)
  const data = usePaletteData(opened)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(
    () => paletteItems({ ...data, profile, scheme: resolved, mod: MOD_LABEL }),
    [data, profile, resolved]
  )
  const sections = useMemo(() => searchPalette(items, query), [items, query])
  const flat = useMemo(() => flatten(sections), [sections])
  const current = flat[Math.min(active, flat.length - 1)]

  // A fresh search each time it opens.
  useEffect(() => {
    if (opened) {
      setQuery('')
      setActive(0)
    }
  }, [opened])

  useEffect(() => setActive(0), [query])

  // The in-app browser is a native view drawn above the page: hide it while something here covers it,
  // and show it again only if the Browser page is still the one on screen. Choosing another page closes
  // the palette in the same commit: the Browser page hides its view as it unmounts, and must stay hidden.
  const covering = opened || addOpen || confirmOpen || error !== null
  const onBrowser = location.page === 'browser'
  const here = useRef(location)
  here.current = location
  useEffect(() => {
    if (!covering || !onBrowser) return
    void api.browser.setVisible(false)
    return () => {
      if (here.current.page === 'browser') void api.browser.setVisible(true)
    }
  }, [covering, onBrowser])

  useEffect(() => {
    if (!current) return
    listRef.current?.querySelector(`[data-item-id="${CSS.escape(current.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  function run(command: PaletteCommand) {
    onClose()
    switch (command.kind) {
      case 'navigate':
        return navigate(command.location.page, command.location.params as never)
      case 'tailor-job':
        return guarded(() => void prepareTailor(command.job, () => undefined).then((job) => navigate('tailor', tailorPrefillFor(job))))
      case 'apply':
        return guarded(() => apply({ id: command.applicationId }))
      case 'open-file':
        return void api.applications.openFile(command.applicationId, command.file).catch((err) => setError(errorText(err)))
      case 'reveal':
        return void api.applications.reveal(command.applicationId).catch((err) => setError(errorText(err)))
      case 'add-job':
        return setAddOpen(true)
      case 'toggle-theme':
        return setPreference(resolved === 'dark' ? 'light' : 'dark')
      case 'switch-workspace':
        return guarded(onSwitchWorkspace)
      case 'automation': {
        const call = command.action === 'pause' ? api.automation.pause() : command.action === 'resume' ? api.automation.resume() : api.automation.runNow()
        return void call.catch((err) => setError(errorText(err)))
      }
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    const n = flat.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (n) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (current) run(current.command)
    } else if (e.key === 'Tab' && sections.length > 1) {
      // Tab: first entry of the next group (Shift+Tab: the previous one); focus stays in the input.
      e.preventDefault()
      const starts: number[] = []
      let at = 0
      sections.forEach((_, i) => {
        starts.push(i === 0 ? 0 : starts[i - 1] + sections[i - 1].items.length)
        if (starts[i] <= active) at = i
      })
      setActive(starts[(at + (e.shiftKey ? sections.length - 1 : 1)) % sections.length])
    }
  }

  let index = 0
  return (
    <>
      <Modal.Root
        opened={opened}
        onClose={onClose}
        size={640}
        yOffset="12vh"
        transitionProps={{ duration: 120 }}
        classNames={{ content: classes.content }}
      >
        <Modal.Overlay />
        <Modal.Content aria-label="Sniff">
          <div className={classes.searchRow}>
            <IconSearch size={18} className={classes.searchIcon} aria-hidden />
            <input
              className={classes.input}
              data-autofocus
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Sniff jobs, runs, applications, settings…"
              aria-label="Sniff anything"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
              spellCheck={false}
              autoComplete="off"
            />
            <Kbd>esc</Kbd>
          </div>
          <div className={classes.list} id={listId} role="listbox" aria-label="Results" ref={listRef}>
            {sections.map((section) => {
              const labelId = `${listId}-${section.group}`
              return (
                <div key={section.group} role="group" aria-labelledby={labelId}>
                  <div className={classes.groupLabel} id={labelId}>
                    {section.label}
                  </div>
                  {section.items.map((item) => {
                    const i = index++
                    return (
                      <Row
                        key={item.id}
                        id={`${listId}-${item.id}`}
                        item={item}
                        selected={item === current}
                        onHover={() => setActive(i)}
                        onChoose={() => run(item.command)}
                      />
                    )
                  })}
                </div>
              )
            })}
            {flat.length === 0 && (
              <Text className={classes.empty} size="sm" c="dimmed">
                {data.loading && query ? 'Sniffing…' : `Nothing smells like “${query}”.`}
              </Text>
            )}
          </div>
          <Group className={classes.footer} gap={12} wrap="nowrap">
            <span>↑↓ move</span>
            <span>↵ open</span>
            <span>tab next group</span>
            <span className={classes.footerSpacer} />
            <span className={classes.footerHint}>
              <IconFlame size={12} className={classes.flame} aria-hidden />
              the hound sniffs jobs, runs, files, settings
            </span>
          </Group>
        </Modal.Content>
      </Modal.Root>

      <AddJobModal
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={(job) => {
          setAddOpen(false)
          // A fresh `reload` remounts the Jobs page (also when it is the page on screen), so it lists the new job.
          navigate('jobs', { reload: Date.now(), tab: 'saved', openId: job.id })
        }}
      />
      {applyModal}
      <Modal opened={error !== null} onClose={() => setError(null)} title="That did not work" centered>
        <Alert color="danger" variant="light">
          {error}
        </Alert>
      </Modal>
    </>
  )
}

function Row({ id, item, selected, onHover, onChoose }: { id: string; item: PaletteItem; selected: boolean; onHover(): void; onChoose(): void }) {
  const ItemIcon = item.icon === 'theme' && item.subtitle === 'to dark' ? IconMoon : item.icon === 'theme' ? IconSun : ICONS[item.icon]
  return (
    <div
      id={id}
      data-item-id={item.id}
      role="option"
      aria-selected={selected}
      className={classes.item}
      data-selected={selected || undefined}
      onMouseMove={selected ? undefined : onHover}
      // Keep focus in the input: a click chooses without blurring it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
    >
      <ItemIcon size={16} stroke={1.7} className={classes.itemIcon} aria-hidden />
      <span className={classes.itemText}>
        <span className={classes.itemTitle}>{item.title}</span>
        {item.subtitle && <span className={classes.itemSubtitle}> · {item.subtitle}</span>}
      </span>
      {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : selected ? <Kbd aria-hidden>↵</Kbd> : null}
    </div>
  )
}
