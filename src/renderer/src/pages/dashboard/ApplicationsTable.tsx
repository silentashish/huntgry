import { ActionIcon, Anchor, Menu, Table, Text, Tooltip, UnstyledButton, VisuallyHidden } from '@mantine/core'
import { IconChevronDown, IconFileDescription, IconFileText, IconFolder, IconSend, IconWorld } from '@tabler/icons-react'
import { APPLICATION_STATUSES, type ApplicationRecord, type ApplicationStatus, type ApplicationTracking } from '@shared/applications-types'
import { api } from '../../api'
import { APPLY_HINT, applyBlocker } from '../../components/apply/blocker'
import { CompanyAvatar, MonoLabel, toneStyle } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { BuildBadge } from './BuildBadge'
import classes from './dashboard.module.css'
import { ReviewBadge } from './ReviewBadge'
import { STATUS_META } from './status'
import { shortDate } from './summary'

interface Props {
  apps: ApplicationRecord[]
  openId: string | null
  onOpen(id: string): void
  onUpdate(id: string, patch: Partial<ApplicationTracking>): void
  onAct(fn: () => Promise<unknown>): void
  onApply(app: ApplicationRecord): void
  /** An Apply is starting; every row's Apply waits for it. */
  applying: boolean
  onClearFilters(): void
}

/** The applications table (Figma Dashboard → Table): one row per application folder. */
export function ApplicationsTable({ apps, openId, onOpen, onUpdate, onAct, onApply, applying, onClearFilters }: Props) {
  const now = new Date()
  return (
    <div className={classes.tableWrap}>
      <Table highlightOnHover className={classes.table} verticalSpacing={0}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Application</Table.Th>
            <Table.Th w={84}>Created</Table.Th>
            <Table.Th w={128}>Status</Table.Th>
            <Table.Th>Build</Table.Th>
            <Table.Th>
              <VisuallyHidden>Actions</VisuallyHidden>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {apps.map((a) => (
            <Row
              key={a.id}
              app={a}
              now={now}
              selected={a.id === openId}
              onOpen={() => onOpen(a.id)}
              onUpdate={(p) => onUpdate(a.id, p)}
              onAct={onAct}
              onApply={() => onApply(a)}
              applying={applying}
            />
          ))}
          {apps.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={5}>
                <Text c="dimmed" ta="center" py="md" size="sm">
                  Nothing matches.{' '}
                  <Anchor component="button" size="sm" onClick={onClearFilters}>
                    Clear filters
                  </Anchor>
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </div>
  )
}

/** The job board or entry the application came from: `url`, `pasted`, `hiring.cafe`, … */
function sourceOf(app: ApplicationRecord): string | null {
  return app.tracking.source ?? null
}

interface RowProps {
  app: ApplicationRecord
  now: Date
  selected: boolean
  onOpen(): void
  onUpdate(patch: Partial<ApplicationTracking>): void
  onAct(fn: () => Promise<unknown>): void
  onApply(): void
  applying: boolean
}

function Row({ app, now, selected, onOpen, onUpdate, onAct, onApply, applying }: RowProps) {
  const { navigate } = useNavigation()
  const has = (f: string) => app.files.includes(f)
  // Controls inside the row must not also open the drawer.
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const source = sourceOf(app)
  const roleLine = [app.role, app.jobTitle && app.jobTitle !== app.role ? app.jobTitle : null].filter(Boolean).join(' · ')
  const blocker = applyBlocker(app)
  return (
    <Table.Tr onClick={onOpen} className={classes.row} data-selected={selected || undefined} bg={selected ? 'var(--hg-bg-hover)' : undefined}>
      <Table.Td>
        <div className={classes.appCell}>
          <CompanyAvatar name={app.company} />
          <div className={classes.appText}>
            <div className={classes.companyLine}>
              <span className={classes.company}>{app.company}</span>
              {source && <span className={classes.sourceTag}>{source}</span>}
            </div>
            <p className={classes.roleLine} title={roleLine}>
              {roleLine}
            </p>
          </div>
        </div>
      </Table.Td>
      <Table.Td>
        <span className={classes.date} title={new Date(app.createdAt).toLocaleString()}>
          {shortDate(app.createdAt, now)}
        </span>
        {app.tracking.appliedAt && (
          <MonoLabel size="xs" component="div" className={classes.appliedOn}>
            applied <span className={classes.appliedDate}>{app.tracking.appliedAt}</span>
          </MonoLabel>
        )}
      </Table.Td>
      <Table.Td onClick={stop}>
        <StatusMenu status={app.tracking.status} onChange={(status) => onUpdate({ status })} />
      </Table.Td>
      <Table.Td>
        <div className={classes.pills}>
          <BuildBadge app={app} short />
          <ReviewBadge app={app} short />
        </div>
      </Table.Td>
      <Table.Td onClick={stop}>
        <div className={classes.actions}>
          <Tooltip label={blocker ?? APPLY_HINT} multiline maw={260}>
            <ActionIcon variant="subtle" color="trail" disabled={blocker !== null || applying} onClick={onApply} aria-label="Apply">
              <IconSend size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Open resume PDF">
            <ActionIcon
              variant="subtle"
              color="gray"
              disabled={!has('resume.pdf')}
              onClick={() => onAct(() => api.applications.openFile(app.id, 'resume.pdf'))}
              aria-label="Open resume"
            >
              <IconFileText size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Open cover letter PDF">
            <ActionIcon
              variant="subtle"
              color="gray"
              disabled={!has('cover.pdf')}
              onClick={() => onAct(() => api.applications.openFile(app.id, 'cover.pdf'))}
              aria-label="Open cover letter"
            >
              <IconFileDescription size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={app.jobUrl ?? 'No posting URL'}>
            <ActionIcon
              variant="subtle"
              color="gray"
              disabled={!app.jobUrl}
              onClick={() => app.jobUrl && navigate('browser', { url: app.jobUrl })}
              aria-label="Open job posting"
            >
              <IconWorld size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Show in Finder">
            <ActionIcon variant="subtle" color="gray" onClick={() => onAct(() => api.applications.reveal(app.id))} aria-label="Show in Finder">
              <IconFolder size={16} />
            </ActionIcon>
          </Tooltip>
        </div>
      </Table.Td>
    </Table.Tr>
  )
}

/** The status pill of a row; opens a menu of the statuses (Figma: Badge with a chevron). */
export function StatusMenu({ status, onChange }: { status: ApplicationStatus; onChange(status: ApplicationStatus): void }) {
  const meta = STATUS_META[status]
  return (
    <Menu position="bottom-start" withinPortal shadow="md">
      <Menu.Target>
        <UnstyledButton className={classes.statusButton} style={toneStyle(meta.tone)} aria-label={`Status: ${meta.label}`}>
          <span className={classes.statusDot} aria-hidden />
          {meta.label}
          <IconChevronDown size={10} aria-hidden />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {APPLICATION_STATUSES.map((s) => (
          <Menu.Item
            key={s}
            leftSection={<span className={classes.statusDot} style={toneStyle(STATUS_META[s].tone, { color: 'var(--tone-fg)' })} aria-hidden />}
            onClick={() => s !== status && onChange(s)}
            aria-current={s === status || undefined}
            fw={s === status ? 600 : undefined}
          >
            {STATUS_META[s].label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}
