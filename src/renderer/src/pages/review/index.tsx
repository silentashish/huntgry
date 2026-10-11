import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Center, Loader, SegmentedControl, Text } from '@mantine/core'
import { IconArrowRight, IconClipboardCheck, IconCpu, IconRefresh, IconShieldCheck } from '@tabler/icons-react'
import { REVIEW_STATE_LABEL, type ReviewDetail, type ReviewItem } from '@shared/review-types'
import { api, errorText } from '../../api'
import { EmptyState, MonoLabel, PageHeader, StatusPill } from '../../components/ui'
import { useNavigation, type PageParams } from '../../navigation'
import { ReviewDetailView } from './ReviewDetail'
import { STATE_TONE, filterItems, reviewEyebrow, sinceLabel, type ReviewFilter } from './review-ui'
import classes from './review.module.css'

/**
 * Unattended results (#31): everything the pipeline built that nobody has
 * looked at yet. Approve (optionally saving reframings as standing
 * approvals), re-run with answers, or discard; each bound to the revision
 * that was shown.
 */
export function ReviewPage({ params }: { params: PageParams['review'] }) {
  const { navigate } = useNavigation()
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [approvals, setApprovals] = useState<number | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [selected, setSelected] = useState<string | null>(params?.applicationId ?? null)
  const [detail, setDetail] = useState<ReviewDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems(await api.review.list())
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
    // The count on the Standing approvals button; the page works without it.
    api.review
      .approvals()
      .then((s) => setApprovals(s.approvals.length))
      .catch(() => setApprovals(null))
  }, [])

  const open = useCallback(async (id: string | null) => {
    setSelected(id)
    setDetail(null)
    if (!id) return
    setLoadingDetail(true)
    try {
      setDetail(await api.review.get(id))
      setError(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const off = api.on('applications:changed', () => void load())
    return off
  }, [load])

  useEffect(() => {
    if (params?.applicationId) void open(params.applicationId)
  }, [params?.applicationId, open])

  // Opened without a result: show the first one once the list is in (Figma opens on a result).
  const autoOpened = useRef(Boolean(params?.applicationId))
  useEffect(() => {
    if (autoOpened.current || !items) return
    autoOpened.current = true
    if (items.length > 0 && selected === null) void open(items[0].applicationId)
  }, [items, selected, open])

  // Reflect a decision: reload the list and the detail (a re-run keeps it open).
  async function decided(next: ReviewDetail) {
    setDetail(next)
    await load()
    if (next.state === 'approved' || next.state === 'discarded') {
      const rest = (await api.review.list()).filter((i) => i.applicationId !== next.applicationId)
      await open(rest[0]?.applicationId ?? null)
    }
  }

  const empty = items !== null && items.length === 0 && !selected

  const header = (
    <PageHeader
      eyebrow={items === null ? ' ' : reviewEyebrow(items)}
      title="Review"
      subtitle={
        empty || items === null
          ? undefined
          : 'Unattended runs use only your profile facts and standing approvals. Everything they left out is listed here. Approve to unlock Apply, re-run with your answers, or discard.'
      }
      actions={
        <>
          <Button variant="default" leftSection={<IconShieldCheck size={16} />} onClick={() => navigate('settings')}>
            Standing approvals{approvals !== null ? ` · ${approvals}` : ''}
          </Button>
          <Button variant="subtle" leftSection={<IconRefresh size={16} />} onClick={() => void load()}>
            Refresh
          </Button>
        </>
      }
    />
  )

  return (
    <div className={classes.page}>
      {header}

      {error && (
        <Alert color="danger" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {items === null && !error && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {empty && (
        <div className={classes.emptyWrap}>
          <EmptyState
            tone="review"
            icon={<IconClipboardCheck size={36} stroke={1.5} />}
            title="Nothing to review"
            description="Results of unattended pipelines land here until you approve them. The hound is sleeping with one ear up."
            actions={
              <>
                <Button variant="primary" leftSection={<IconCpu size={16} />} onClick={() => navigate('jobs')}>
                  Start an unattended run
                </Button>
                <Button variant="default" rightSection={<IconArrowRight size={16} />} onClick={() => navigate('tailor', { view: 'queue' })}>
                  Tailoring queue
                </Button>
              </>
            }
            hint="On Jobs, pick the jobs, then Tailor all → Run unattended."
          />
        </div>
      )}

      {items && (items.length > 0 || selected) && (
        <div className={classes.layout}>
          <ReviewList items={items} filter={filter} onFilter={setFilter} selected={selected} onOpen={(id) => void open(id)} />
          <div style={{ minWidth: 0 }}>
            {loadingDetail && (
              <Center py="xl">
                <Loader />
              </Center>
            )}
            {!loadingDetail && !detail && (
              <Text c="dimmed" size="sm">
                Pick a result on the left.
              </Text>
            )}
            {detail && <ReviewDetailView key={detail.applicationId} detail={detail} onDecided={decided} onReload={() => void open(detail.applicationId)} />}
          </div>
        </div>
      )}
    </div>
  )
}

function ReviewList({
  items,
  filter,
  onFilter,
  selected,
  onOpen
}: {
  items: ReviewItem[]
  filter: ReviewFilter
  onFilter(f: ReviewFilter): void
  selected: string | null
  onOpen(id: string): void
}) {
  const shown = filterItems(items, filter)
  const now = Date.now()
  return (
    <section className={classes.list} aria-label="Results to review">
      <SegmentedControl
        className={classes.filter}
        size="xs"
        value={filter}
        onChange={(v) => onFilter(v as ReviewFilter)}
        data={[
          { value: 'all', label: `All (${items.length})` },
          { value: 'unreviewed', label: 'Unreviewed' },
          { value: 'attention', label: 'Attention' }
        ]}
      />
      {shown.map((i) => {
        const meta = REVIEW_STATE_LABEL[i.state]
        return (
          <button key={i.applicationId} type="button" className={classes.item} aria-current={selected === i.applicationId ? 'true' : undefined} onClick={() => onOpen(i.applicationId)}>
            <span className={classes.itemTitle}>{i.title}</span>
            <span className={classes.itemMeta}>
              <StatusPill tone={STATE_TONE[i.state]} dot>
                {meta.label}
              </StatusPill>
              {i.build.status === 'fail' && <StatusPill tone="danger">build failed</StatusPill>}
              <MonoLabel size="xs" className={classes.itemTime} title={new Date(i.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>
                {sinceLabel(i.at, now)}
              </MonoLabel>
            </span>
          </button>
        )
      })}
      {shown.length === 0 && (
        <Text size="sm" c="dimmed" p="xs">
          {items.length === 0 ? 'Nothing else to review.' : 'Nothing here.'}
        </Text>
      )}
      <p className={classes.listNote}>Approved and discarded results stay on the Dashboard.</p>
    </section>
  )
}
