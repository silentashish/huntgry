import { useState } from 'react'
import { ActionIcon, Button, Menu, Tooltip } from '@mantine/core'
import {
  IconArchive,
  IconArrowsRightLeft,
  IconCheck,
  IconClipboardCheck,
  IconDotsVertical,
  IconEyeOff,
  IconSend,
  IconSparkles,
  IconTerminal2
} from '@tabler/icons-react'
import { BOARD_COLUMNS, BOARD_COLUMN_LABEL, moveTargets, type BoardCard, type BoardColumnId } from '@shared/board'
import { CompanyAvatar, MonoLabel, ScoreRing, StatusPill, scoreLabel } from '../../components/ui'
import { applyBlocker } from '../../components/apply/blocker'
import { cardMeta, cardPills, companyOf, type Scent } from './card'
import classes from './board.module.css'

interface Props {
  card: BoardCard
  /** The Scent ring (see `cardScent`); worked out by the page once per board. */
  scent: Scent
  /** The card is being dragged. */
  dragging: boolean
  /** The top card of To do: its Tailor button is the solid one (Figma). */
  lead?: boolean
  onDragStart(): void
  onDragEnd(): void
  onOpen(): void
  onMove(to: BoardColumnId): void
  /** To do: queue the job for tailoring. */
  onTailor(): void
  /** Needs review / Tailoring: the run on the Tailor page, or the result on the Review page. */
  onFollow(): void
  /** Ready to apply: start auto-apply in the in-app browser. */
  onApply(): void
  /** An Apply is starting (the page's `useApply` is busy): the Apply button waits. */
  applying?: boolean
  /**
   * A card of an older week (#160): one line with the company, the title and the score, and the
   * full card while it is hovered or has focus. Its Move to menu stays on that line.
   */
  compact?: boolean
}

/** One job on the Board (Figma Kanban card): company, role, Scent, where it stands, its next step and Move to. */
export function BoardCardView({ card, scent, dragging, lead, onDragStart, onDragEnd, onOpen, onMove, onTailor, onFollow, onApply, applying, compact }: Props) {
  const targets = moveTargets(card)
  const company = companyOf(card)
  const meta = cardMeta(card)
  // Controls inside the card must not also open its drawer.
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  return (
    <article
      aria-label={card.title}
      className={classes.card}
      data-compact={compact ? 'true' : undefined}
      tabIndex={0}
      draggable={targets.length > 0}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', card.key)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen()
        }
      }}
      style={{ opacity: dragging ? 0.5 : 1 }}
    >
      <div className={classes.cardHead}>
        {company && <CompanyAvatar name={company} size="sm" className={classes.cardAvatar} />}
        <div className={classes.cardHeadText}>
          <h4 className={classes.cardTitle}>{card.title}</h4>
          {card.subtitle && <div className={classes.cardSubtitle}>{card.subtitle}</div>}
        </div>
        {compact && (
          // Shown instead of the head text and the rest of the card until it is hovered or focused.
          <div className={classes.compactLine} aria-hidden>
            <span className={classes.compactText}>{[company, card.title].filter(Boolean).join(' · ')}</span>
            {scent.mode === 'score' && <MonoLabel size="xs">{scent.value}</MonoLabel>}
          </div>
        )}
        {targets.length > 0 && (
          <div onClick={stop}>
            <MoveMenu card={card} targets={targets} onMove={onMove} />
          </div>
        )}
      </div>

      <Pills card={card} />

      <div className={classes.foot}>
        <Ring scent={scent} />
        <MonoLabel size="xs" className={classes.meta} title={meta}>
          {meta}
        </MonoLabel>
        <div onClick={stop}>
          <NextStep card={card} lead={lead} onTailor={onTailor} onFollow={onFollow} onApply={onApply} applying={applying} />
        </div>
      </div>
    </article>
  )
}

function Ring({ scent }: { scent: Scent }) {
  if (scent.mode === 'score') {
    const why = [scoreLabel(scent.value), ...scent.reasons].join(' · ')
    return (
      <Tooltip label={why} multiline maw={260} openDelay={300}>
        <span>
          <ScoreRing value={scent.value} size="sm" />
        </span>
      </Tooltip>
    )
  }
  if (scent.mode === 'done') return <ScoreRing mode="done" size="sm" aria-label="Tailored" />
  return <ScoreRing mode="initial" letter={scent.letter} size="sm" aria-label="No Scent score yet" />
}

function Pills({ card }: { card: BoardCard }) {
  const pills = cardPills(card)
  if (pills.length === 0) return null
  return (
    <div className={classes.pills}>
      {pills.map((p) => (
        <StatusPill key={p.label} tone={p.tone} variant={p.variant} dot={p.dot} title={p.title}>
          {p.label}
        </StatusPill>
      ))}
    </div>
  )
}

/** The Move to menu (Figma Menu 22:585): the current column ticked, the others, then Archive (or Dismiss job). */
function MoveMenu({ card, targets, onMove }: { card: BoardCard; targets: BoardColumnId[]; onMove(to: BoardColumnId): void }) {
  const columns = BOARD_COLUMNS.filter((c) => c === card.column || (c !== 'archived' && targets.includes(c)))
  const archive = targets.includes('archived')
  const [opened, setOpened] = useState(false)
  return (
    <Menu position="bottom-end" width={232} withinPortal opened={opened} onChange={setOpened}>
      <Menu.Target>
        <Tooltip label="Move to…" openDelay={400} disabled={opened}>
          <ActionIcon variant="subtle" color="gray" size={22} aria-label={`Move ${card.title}`} className={classes.cardMenu}>
            <IconDotsVertical size={14} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <div className={classes.menuHead}>
          <IconArrowsRightLeft size={16} aria-hidden />
          Move to…
        </div>
        <Menu.Divider />
        {columns.map((c) =>
          c === card.column ? (
            // The card's own column: shown ticked and announced, but not something to pick.
            <Menu.Item
              key={c}
              disabled
              aria-label={`${BOARD_COLUMN_LABEL[c]} (current column)`}
              className={classes.menuCurrent}
              rightSection={<IconCheck size={14} aria-hidden />}
            >
              {BOARD_COLUMN_LABEL[c]}
            </Menu.Item>
          ) : (
            <Menu.Item key={c} onClick={() => onMove(c)}>
              {BOARD_COLUMN_LABEL[c]}
            </Menu.Item>
          )
        )}
        {archive && (
          <>
            <Menu.Divider />
            {card.kind === 'job' ? (
              <Menu.Item leftSection={<IconEyeOff size={16} />} onClick={() => onMove('archived')}>
                Dismiss job
              </Menu.Item>
            ) : (
              <Menu.Item leftSection={<IconArchive size={16} />} onClick={() => onMove('archived')}>
                Archive
              </Menu.Item>
            )}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  )
}

function NextStep({ card, lead, onTailor, onFollow, onApply, applying }: Pick<Props, 'card' | 'lead' | 'onTailor' | 'onFollow' | 'onApply' | 'applying'>) {
  if (card.kind === 'job' && card.column === 'todo') {
    return (
      <Button size="xs" variant={lead ? 'filled' : 'secondary'} className={classes.action} leftSection={<IconSparkles size={14} />} onClick={onTailor}>
        Tailor
      </Button>
    )
  }
  if (card.kind === 'queue') {
    return card.item.status === 'needs-reply' ? (
      <Button size="xs" className={classes.action} leftSection={<IconSend size={14} />} onClick={onFollow}>
        Reply
      </Button>
    ) : (
      <Button size="xs" variant="secondary" className={classes.action} leftSection={<IconTerminal2 size={14} />} onClick={onFollow}>
        Open run
      </Button>
    )
  }
  if (card.kind === 'application' && card.column === 'review') {
    return (
      <Button size="xs" variant="secondary" className={classes.action} leftSection={<IconClipboardCheck size={14} />} onClick={onFollow}>
        Review
      </Button>
    )
  }
  if (card.kind === 'application' && card.column === 'ready' && applyBlocker(card.app) === null) {
    return (
      <Tooltip label="Fill the application form in the in-app browser; you submit it" multiline maw={240} openDelay={400}>
        <Button size="xs" className={classes.action} leftSection={<IconSend size={14} />} loading={applying} disabled={applying} onClick={onApply}>
          Apply
        </Button>
      </Tooltip>
    )
  }
  return null
}
