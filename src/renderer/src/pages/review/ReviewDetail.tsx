import { useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Code, Collapse, Divider, Tabs, Text, Textarea } from '@mantine/core'
import { IconCheck, IconExternalLink, IconFileText, IconFlame, IconRefresh, IconShieldCheck, IconTrash } from '@tabler/icons-react'
import { REVIEW_STATE_LABEL, type ProposedReframing, type ReviewDetail, type ReviewOutcome } from '@shared/review-types'
import { api, errorText } from '../../api'
import { MonoLabel, SectionCard, StatusPill } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { Markdown } from '../tailor/Transcript'
import { STATE_TONE, approveHint, buildWarnings, shortRevision, shownTicked } from './review-ui'
import classes from './review.module.css'

interface Props {
  detail: ReviewDetail
  onDecided(next: ReviewDetail): void
  onReload(): void
}

type Decision = 'approve' | 'rerun' | 'discard'

/**
 * One unattended result (Figma Review — Detail): the header with its files and revision, verify,
 * the reframings to tick, the standing approvals used and the open gaps, the previews, and the
 * Decision card. Approve, re-run and discard all carry the revision that is on screen.
 */
export function ReviewDetailView({ detail: d, onDecided, onReload }: Props) {
  const { navigate } = useNavigation()
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [answers, setAnswers] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [rawReport, setRawReport] = useState(false)
  const [busy, setBusy] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const meta = REVIEW_STATE_LABEL[d.state]
  const decidable = d.state === 'unreviewed' || d.state === 'needs-attention'
  // Only reframings of the revision on screen are sent (a reload can bring other ones).
  const ids = shownTicked(d.proposedReframings, ticked)
  const hasResume = d.artifacts.some((a) => a.file === 'resume.pdf')
  const hasCover = d.artifacts.some((a) => a.file === 'cover.pdf')
  const warnings = useMemo(() => buildWarnings(d.verify.report), [d.verify.report])

  async function decide(kind: Decision, call: () => Promise<ReviewOutcome>) {
    setBusy(kind)
    setError(null)
    setStale(null)
    try {
      const out = await call()
      if (!out.ok) {
        if (out.error === 'stale') setStale(out.message)
        else setError(out.message)
        return
      }
      setTicked(new Set())
      setAnswers('')
      setConfirmDiscard(false)
      onDecided(out.detail)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const openFile = (file: string) => void api.applications.openFile(d.applicationId, file).catch((e) => setError(errorText(e)))

  return (
    <div className={classes.detail}>
      <SectionCard padding="md" aria-label={`Result: ${d.title}`}>
        <div className={classes.headTop}>
          <div className={classes.headText}>
            <div className={classes.headTitleRow}>
              <h3 className={classes.headTitle}>{d.title}</h3>
              <StatusPill tone={STATE_TONE[d.state]} dot>
                {meta.label}
              </StatusPill>
              <StatusPill title={`Revision ${d.revision}`}>
                <MonoLabel tone="inherit">rev {shortRevision(d.revision)}</MonoLabel>
              </StatusPill>
            </div>
            <MonoLabel tone="muted" component="div" className={classes.headPath}>
              {d.applicationId}/ · run {d.runId} · unattended
            </MonoLabel>
            {d.reason && (
              <p className={classes.headReason} data-attention={d.state === 'needs-attention' || undefined}>
                {d.reason}
              </p>
            )}
          </div>
          <div className={classes.headActions}>
            {hasResume && (
              <Button size="xs" variant="default" leftSection={<IconFileText size={14} />} onClick={() => openFile('resume.pdf')}>
                Resume
              </Button>
            )}
            {hasCover && (
              <Button size="xs" variant="default" onClick={() => openFile('cover.pdf')}>
                Cover letter
              </Button>
            )}
            {d.jobUrl && (
              <Button size="xs" variant="subtle" leftSection={<IconExternalLink size={14} />} onClick={() => navigate('browser', { url: d.jobUrl! })}>
                Posting
              </Button>
            )}
          </div>
        </div>

        {(stale || error) && (
          <div className={classes.headAlerts}>
            {stale && (
              <div className={classes.changed} role="alert">
                <span className={classes.changedIcon} aria-hidden>
                  <IconFlame size={18} />
                </span>
                <div className={classes.changedBody}>
                  <p className={classes.changedTitle}>This result changed</p>
                  <p className={classes.changedText} title={stale}>
                    It was rebuilt since you opened it (you saw rev {shortRevision(d.revision)}). Reload it and decide again.
                  </p>
                  <Button size="xs" variant="secondary" leftSection={<IconRefresh size={14} />} onClick={onReload}>
                    Reload
                  </Button>
                </div>
              </div>
            )}
            {error && (
              <Alert color="danger" variant="light" withCloseButton onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
          </div>
        )}
      </SectionCard>

      <div className={classes.columns}>
        <div className={classes.main}>
          <SectionCard
            padding="md"
            title={
              // The icon rides in the title so it stays with it when the pills wrap.
              <span className={classes.iconTitle}>
                <IconShieldCheck size={16} aria-hidden />
                Verify
              </span>
            }
            badge={
              <>
                <StatusPill tone={d.build.status === 'pass' ? 'success' : d.build.status === 'fail' ? 'danger' : 'neutral'}>
                  {d.build.status === 'pass' ? 'ATS checks passed' : d.build.status === 'fail' ? 'Build failed' : 'No build report'}
                </StatusPill>
                {d.build.warnings > 0 && (
                  <StatusPill tone="warning" variant="outline">
                    {d.build.warnings} warning{d.build.warnings === 1 ? '' : 's'}
                  </StatusPill>
                )}
              </>
            }
            actions={
              d.verify.report ? (
                <Button size="compact-xs" variant="subtle" color="trail" onClick={() => setRawReport((v) => !v)} aria-expanded={rawReport}>
                  {rawReport ? 'Hide' : 'Show'} build-report.json
                </Button>
              ) : undefined
            }
          >
            {d.build.failed.length > 0 || warnings.length > 0 || d.verify.report ? (
              <>
                {d.build.failed.length > 0 && (
                  <p className={classes.verifyText} data-tone="danger">
                    Failed: {d.build.failed.join(', ')}
                  </p>
                )}
                {warnings.length > 0 && <p className={classes.verifyText}>Warnings: {warnings.join(' · ')}</p>}
                {d.verify.report && (
                  <Collapse expanded={rawReport}>
                    <Code block className={classes.report}>
                      {d.verify.report}
                    </Code>
                  </Collapse>
                )}
              </>
            ) : null}
          </SectionCard>

          <SectionCard
            padding="md"
            title="Proposed reframings the run left out"
            description={
              d.proposedReframings.length > 0
                ? 'Tick the ones that are true. Ticked reframings become standing approvals: later unattended runs may use them as written, for any job.'
                : undefined
            }
          >
            {d.parseWarning && (
              <Alert color="warning" variant="light" py={6} mb="sm">
                <Text size="sm">{d.parseWarning}</Text>
              </Alert>
            )}
            {d.proposedReframings.length === 0 && !d.parseWarning && (
              <Text size="sm" c="dimmed">
                None: everything in the resume is a direct hit or a standing approval.
              </Text>
            )}
            {d.proposedReframings.length > 0 && (
              <div className={classes.reframings}>
                {d.proposedReframings.map((r, i) => (
                  <Reframing key={r.id} r={r} index={i} checked={ticked.has(r.id)} disabled={!decidable} onToggle={() => toggle(r.id)} />
                ))}
              </div>
            )}
          </SectionCard>

          {(d.usedApprovals.length > 0 || d.openGaps.length > 0) && (
            <SectionCard padding="md" title={d.usedApprovals.length > 0 ? 'Standing approvals used' : 'Open gaps'}>
              {d.usedApprovals.length > 0 && (
                <ul className={classes.used}>
                  {d.usedApprovals.map((u, i) => (
                    <li key={i} className={classes.usedRow}>
                      <span className={classes.usedCheck} aria-hidden>
                        <IconCheck size={12} stroke={2.5} />
                      </span>
                      <span className={classes.usedWording}>{u.wording}</span>
                      <span className={classes.usedFact}>← {u.sourceFact}</span>
                    </li>
                  ))}
                </ul>
              )}
              {d.usedApprovals.length > 0 && d.openGaps.length > 0 && (
                <>
                  <hr className={classes.divider} />
                  <h3 className={classes.subTitle}>Open gaps</h3>
                </>
              )}
              {d.openGaps.length > 0 && (
                <div className={classes.gaps}>
                  {d.openGaps.map((g) => (
                    <StatusPill key={g} tone="warning" variant="outline" size="md">
                      {g}
                    </StatusPill>
                  ))}
                </div>
              )}
            </SectionCard>
          )}

          <SectionCard padding="md" aria-label="Previews">
            <Tabs defaultValue={d.resumePages.length > 0 ? 'resume' : 'notes'} keepMounted={false}>
              <Tabs.List>
                <Tabs.Tab value="notes">Review notes</Tabs.Tab>
                <Tabs.Tab value="resume" disabled={d.resumePages.length === 0}>
                  Resume ({d.resumePages.length})
                </Tabs.Tab>
                <Tabs.Tab value="cover" disabled={d.coverPages.length === 0}>
                  Cover letter ({d.coverPages.length})
                </Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="notes" pt="md">
                {d.reviewNotes ? (
                  <div className={classes.notes}>
                    {/* The format marker (<!-- huntgry-review v1 … -->) is for the parser, not the reader. */}
                    <Markdown text={d.reviewNotes.replace(/<!--[\s\S]*?-->/g, '')} />
                  </div>
                ) : (
                  <Text size="sm" c="dimmed">
                    {d.parseWarning?.startsWith('This result has no') ? 'No review-notes.md in this folder.' : 'The notes are too long to show here; open the folder.'}
                  </Text>
                )}
              </Tabs.Panel>
              <Tabs.Panel value="resume" pt="md">
                <Pages id={d.applicationId} pages={d.resumePages} />
              </Tabs.Panel>
              <Tabs.Panel value="cover" pt="md">
                <Pages id={d.applicationId} pages={d.coverPages} />
              </Tabs.Panel>
            </Tabs>
          </SectionCard>
        </div>

        <aside className={classes.side}>
          <SectionCard padding="md" title="Decision">
            {decidable ? (
              <div className={classes.decision}>
                <Button
                  variant="primary"
                  fullWidth
                  leftSection={<IconCheck size={16} />}
                  loading={busy === 'approve'}
                  disabled={busy !== null}
                  onClick={() => decide('approve', () => api.review.approve({ applicationId: d.applicationId, revision: d.revision, approvedReframingIds: ids }))}
                >
                  Approve{ids.length ? ` (+${ids.length} standing)` : ''}
                </Button>
                <p className={classes.hint}>{approveHint(d.proposedReframings, ids)}</p>
                <Divider />
                <Textarea
                  label="Re-run with my answers"
                  autosize
                  minRows={3}
                  placeholder="e.g. Use R1 but say “contributed to”, not “led”. Drop R2."
                  value={answers}
                  onChange={(e) => setAnswers(e.currentTarget.value)}
                />
                <Button
                  variant="secondary"
                  fullWidth
                  leftSection={<IconRefresh size={16} />}
                  loading={busy === 'rerun'}
                  disabled={busy !== null || (!answers.trim() && ids.length === 0)}
                  onClick={() => decide('rerun', () => api.review.rerun({ applicationId: d.applicationId, revision: d.revision, answers, approvedReframingIds: ids }))}
                >
                  Send and rebuild
                </Button>
                <p className={classes.hint}>
                  Sent to the run’s own session, with the ticked reframings as approved. The result comes back here as Unreviewed with a new revision.
                </p>
                <Divider />
                {!confirmDiscard ? (
                  <>
                    <Button variant="light" color="danger" fullWidth leftSection={<IconTrash size={16} />} disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>
                      Discard
                    </Button>
                    <p className={classes.hint}>Archives this result; files are kept.</p>
                  </>
                ) : (
                  <div className={classes.confirm}>
                    <p className={classes.confirmText}>Archive this result (files are kept)?</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        size="xs"
                        color="danger"
                        leftSection={<IconTrash size={14} />}
                        loading={busy === 'discard'}
                        onClick={() => decide('discard', () => api.review.discard({ applicationId: d.applicationId, revision: d.revision }))}
                      >
                        Discard
                      </Button>
                      <Button size="xs" variant="subtle" onClick={() => setConfirmDiscard(false)}>
                        Keep
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className={classes.decision}>
                <StatusPill tone={STATE_TONE[d.state]} dot size="md">
                  {meta.label}
                </StatusPill>
                <p className={classes.hint}>
                  {d.state === 'approved' ? 'Apply is unlocked for this application.' : 'This result was archived; its files are kept.'}
                </p>
              </div>
            )}
          </SectionCard>
        </aside>
      </div>
    </div>
  )
}

/** One proposed reframing: the whole box toggles its checkbox. */
function Reframing({ r, index, checked, disabled, onToggle }: { r: ProposedReframing; index: number; checked: boolean; disabled: boolean; onToggle(): void }) {
  return (
    <label className={classes.reframing} data-checked={checked || undefined} data-disabled={disabled || undefined}>
      <Checkbox mt={1} checked={checked} disabled={disabled} onChange={onToggle} aria-label={`Approve: ${r.wording}`} />
      <span className={classes.reframingBody}>
        <MonoLabel tone="muted">
          R{index + 1}
          {r.requirement ? ` · ${r.requirement}` : ''}
        </MonoLabel>
        <span className={classes.reframingRow}>
          <MonoLabel size="xs">Fact</MonoLabel>
          <span className={classes.fact}>{r.sourceFact}</span>
        </span>
        <span className={classes.reframingRow}>
          <MonoLabel size="xs">Wording</MonoLabel>
          <span className={classes.wording}>{r.wording}</span>
        </span>
        {r.reason && (
          <span className={classes.reframingRow}>
            <MonoLabel size="xs">Why unsure</MonoLabel>
            <span className={classes.unsure}>{r.reason}</span>
          </span>
        )}
      </span>
    </label>
  )
}

function Pages({ id, pages }: { id: string; pages: string[] }) {
  if (pages.length === 0)
    return (
      <Text c="dimmed" size="sm">
        No page previews in this folder.
      </Text>
    )
  return (
    <div className={classes.pages}>
      {pages.map((p) => (
        <img key={p} src={api.applications.fileUrl(id, p)} alt={p} className={classes.pageImage} />
      ))}
    </div>
  )
}
