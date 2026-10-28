import { ActionIcon, Kbd, Tooltip, VisuallyHidden } from '@mantine/core'
import {
  IconBriefcase,
  IconClipboardCheck,
  IconCpu,
  IconDeviceDesktop,
  IconFolder,
  IconLayoutDashboard,
  IconLayoutKanban,
  IconMoon,
  IconRobot,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSun,
  IconSwitchHorizontal,
  IconUser,
  IconWorld,
  type Icon
} from '@tabler/icons-react'
import { NAV_GROUPS, PAGE_LABEL, type NavPage } from '../../navigation'
import { THEME_PREFERENCE_LABELS, THEME_PREFERENCES, useThemePreference, type ThemePreference } from '../../theme'
import { useAutomationState } from '../automation/useAutomation'
import { automationBadge } from '../../pages/automation/view'
import { usePipeline } from '../queue/usePipeline'
import { MonoLabel, PawLogo, ProgressBar, StatusPill } from '../ui'
import { CoffeeLink } from './CoffeeLink'
import { pipelineMini } from './pipelineMini'
import { tailorBadge } from './counts'
import { useNavCounts } from './useNavCounts'
import { APP_VERSION, versionLine } from './version'
import classes from './shell.module.css'

const NAV_ICON: Record<NavPage, Icon> = {
  dashboard: IconLayoutDashboard,
  board: IconLayoutKanban,
  jobs: IconBriefcase,
  browser: IconWorld,
  tailor: IconSparkles,
  review: IconClipboardCheck,
  automation: IconRobot,
  profile: IconUser,
  settings: IconSettings
}

const THEME_ICON: Record<ThemePreference, Icon> = { system: IconDeviceDesktop, light: IconSun, dark: IconMoon }

interface Props {
  current: NavPage | null
  onNavigate(page: NavPage): void
  onOpenPipeline(): void
  onOpenPalette(): void
  /** `⌘` or `Ctrl`. */
  mod: string
  workspacePath: string
  onSwitchWorkspace(): void
}

/**
 * The sidebar (Figma 5:3): paw and version, the "Sniff anything…" button that opens the ⌘K palette, the
 * 9 pages in the hunt's groups (#189: Dashboard and Board, then Hunt, then Setup) with counts on Tailor, Review and
 * Automation (#154: ready to submit, warning when a job needs you), the unattended pipeline while one runs,
 * "Buy me a coffee" (#185), the System / Light / Dark toggle and the workspace with its switch.
 */
export function Sidebar({ current, onNavigate, onOpenPipeline, onOpenPalette, mod, workspacePath, onSwitchWorkspace }: Props) {
  const counts = useNavCounts()
  const [pipeline] = usePipeline()
  const mini = pipelineMini(pipeline)
  const { preference, setPreference } = useThemePreference()
  const tailor = tailorBadge(counts)
  const automation = automationBadge(useAutomationState())
  const badges: Partial<Record<NavPage, { count: number; label: string; tone?: 'accent' | 'warning' } | null>> = {
    tailor,
    review: counts.review ? { count: counts.review, label: `${counts.review} waiting for review` } : null,
    automation
  }

  return (
    <>
      <div className={classes.brand}>
        <span className={classes.paw}>
          <PawLogo size={30} />
        </span>
        <div>
          <div className={classes.brandName}>Huntgry</div>
          <div className={classes.version} title={APP_VERSION ? `Huntgry ${APP_VERSION}` : undefined}>
            {versionLine()}
          </div>
        </div>
      </div>

      <button type="button" className={classes.search} onClick={onOpenPalette} aria-keyshortcuts="Meta+K Control+K">
        <IconSearch size={16} stroke={1.7} aria-hidden />
        <span className={classes.searchLabel}>Sniff anything…</span>
        <Kbd aria-hidden>{mod === '⌘' ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>

      <div className={classes.nav}>
        {NAV_GROUPS.map((group) => {
          const entries = group.pages.map((page) => {
            const PageIcon = NAV_ICON[page]
            const active = current === page
            const badge = badges[page]
            return (
              <button
                key={page}
                type="button"
                className={classes.navItem}
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(page)}
              >
                <PageIcon size={18} stroke={1.6} className={classes.navIcon} aria-hidden />
                <span className={classes.navLabel}>{PAGE_LABEL[page]}</span>
                {badge && (
                  <>
                    <span className={classes.count} data-tone={badge.tone} aria-hidden title={badge.label}>
                      {badge.count}
                    </span>
                    <VisuallyHidden> ({badge.label})</VisuallyHidden>
                  </>
                )}
              </button>
            )
          })
          // A labelled group is announced by its name ("Hunt"); the label itself is not read twice or focusable.
          return group.label ? (
            <div key={group.label} className={classes.navGroup} role="group" aria-label={group.label}>
              <MonoLabel size="xs" component="div" className={classes.navGroupLabel}>
                <span aria-hidden>{group.label}</span>
              </MonoLabel>
              {entries}
            </div>
          ) : (
            <div key="top" className={classes.navGroup}>
              {entries}
            </div>
          )
        })}
      </div>

      <div className={classes.spacer} />

      {mini && (
        <button type="button" className={classes.pipeline} onClick={onOpenPipeline} aria-label={`Unattended run: ${mini.status.label}, ${mini.facts}. Open the queue`}>
          <span className={classes.pipelineHead}>
            <IconCpu size={14} stroke={1.7} aria-hidden />
            <span className={classes.pipelineTitle}>Unattended run</span>
            <StatusPill tone={mini.status.tone} dot>
              {mini.status.label}
            </StatusPill>
          </span>
          <ProgressBar value={mini.percent} tone="trail" aria-label={`${mini.done} of ${mini.total} jobs`} />
          <span className={classes.pipelineFacts}>{mini.facts}</span>
        </button>
      )}

      <div className={classes.bottom}>
        <CoffeeLink />
        <div className={classes.theme} role="group" aria-label="Theme">
          {THEME_PREFERENCES.map((p) => {
            const ThemeIcon = THEME_ICON[p]
            return (
              <Tooltip key={p} label={THEME_PREFERENCE_LABELS[p]} openDelay={400}>
                <button
                  type="button"
                  className={classes.themeOption}
                  aria-pressed={preference === p}
                  aria-label={`${THEME_PREFERENCE_LABELS[p]} theme`}
                  onClick={() => setPreference(p)}
                >
                  <ThemeIcon size={14} stroke={1.8} aria-hidden />
                </button>
              </Tooltip>
            )
          })}
        </div>
        <div className={classes.workspace}>
          <IconFolder size={14} stroke={1.7} aria-hidden style={{ flex: 'none' }} />
          <Tooltip label={workspacePath} multiline maw={360} openDelay={400}>
            <span className={classes.workspacePath}>
              <bdi>{workspacePath}</bdi>
            </span>
          </Tooltip>
          <Tooltip label="Switch workspace" openDelay={300}>
            <ActionIcon variant="subtle" size="sm" color="gray" aria-label="Switch workspace" onClick={onSwitchWorkspace}>
              <IconSwitchHorizontal size={14} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>
    </>
  )
}
