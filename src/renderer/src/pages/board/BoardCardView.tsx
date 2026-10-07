import { ActionIcon, Badge, Button, Card, Group, Menu, Stack, Text, Tooltip } from '@mantine/core'
import { IconArrowsMove, IconEyeCheck, IconSparkles, IconTerminal2 } from '@tabler/icons-react'
import { BOARD_COLUMN_LABEL, moveTargets, type BoardCard, type BoardColumnId } from '@shared/board'
import { BuildBadge } from '../dashboard/ApplicationDrawer'
import { ReviewBadge } from '../dashboard/ReviewBadge'
import { QUEUE_STATUS_LABEL } from '../tailor/status'

interface Props {
  card: BoardCard
  /** The card is being dragged. */
  dragging: boolean
  onDragStart(): void
  onDragEnd(): void
  onOpen(): void
  onMove(to: BoardColumnId): void
  /** To do: queue the job for tailoring. */
  onTailor(): void
  /** Waiting for review / Tailoring: the run on the Tailor page, or the result on the Review page. */
  onFollow(): void
}

/** One job on the Board: what it is, where it stands, its next step and the Move to menu. */
export function BoardCardView({ card, dragging, onDragStart, onDragEnd, onOpen, onMove, onTailor, onFollow }: Props) {
  const targets = moveTargets(card)
  // Controls inside the card must not also open its drawer.
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  return (
    <Card
      component="article"
      aria-label={card.title}
      withBorder
      radius="md"
      padding="sm"
      draggable={targets.length > 0}
      onDragStart={(e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', card.key)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      style={{ cursor: targets.length > 0 ? 'grab' : 'pointer', opacity: dragging ? 0.5 : 1 }}
    >
      <Stack gap={6}>
        <div>
          <Text fw={600} size="sm" lineClamp={2}>
            {card.title}
          </Text>
          {card.subtitle && (
            <Text size="xs" c="dimmed" truncate>
              {card.subtitle}
            </Text>
          )}
        </div>
        <Badges card={card} />
        <Group gap={4} justify="space-between" wrap="nowrap" onClick={stop}>
          <NextStep card={card} onTailor={onTailor} onFollow={onFollow} />
          {targets.length > 0 && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Tooltip label="Move to…" openDelay={400}>
                  <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Move ${card.title}`} ml="auto">
                    <IconArrowsMove size={16} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Move to</Menu.Label>
                {targets.map((to) => (
                  <Menu.Item key={to} onClick={() => onMove(to)}>
                    {BOARD_COLUMN_LABEL[to]}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </Stack>
    </Card>
  )
}

function Badges({ card }: { card: BoardCard }) {
  if (card.kind === 'job') {
    const j = card.job
    if (!j.remote && !j.tailoredAt) return null
    return (
      <Group gap={4}>
        {j.remote && (
          <Badge size="xs" variant="light" color="teal">
            Remote
          </Badge>
        )}
        {j.tailoredAt && (
          <Badge size="xs" variant="light" color="green">
            Tailored
          </Badge>
        )}
      </Group>
    )
  }
  if (card.kind === 'queue') {
    const meta = QUEUE_STATUS_LABEL[card.item.status]
    return (
      <Group gap={4}>
        <Tooltip label={card.item.error ?? meta.label} disabled={!card.item.error} multiline maw={260}>
          <Badge size="xs" variant="light" color={meta.color}>
            {meta.label}
          </Badge>
        </Tooltip>
        {card.item.unattended && (
          <Badge size="xs" variant="outline" color="gray">
            Unattended
          </Badge>
        )}
      </Group>
    )
  }
  const t = card.app.tracking
  return (
    <Group gap={4}>
      <BuildBadge app={card.app} short />
      <ReviewBadge app={card.app} short />
      {t.appliedAt && (
        <Text size="xs" c="dimmed">
          applied {t.appliedAt}
        </Text>
      )}
    </Group>
  )
}

function NextStep({ card, onTailor, onFollow }: Pick<Props, 'card' | 'onTailor' | 'onFollow'>) {
  if (card.kind === 'job' && card.column === 'todo') {
    return (
      <Button size="compact-xs" variant="light" leftSection={<IconSparkles size={12} />} onClick={onTailor}>
        Tailor
      </Button>
    )
  }
  if (card.kind === 'queue') {
    return (
      <Button size="compact-xs" variant="light" leftSection={<IconTerminal2 size={12} />} onClick={onFollow}>
        {card.item.status === 'needs-reply' ? 'Reply' : 'Open run'}
      </Button>
    )
  }
  if (card.kind === 'application' && card.column === 'review') {
    return (
      <Button size="compact-xs" variant="light" color="yellow" leftSection={<IconEyeCheck size={12} />} onClick={onFollow}>
        Review
      </Button>
    )
  }
  return <span />
}
