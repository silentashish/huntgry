import { useEffect, useState } from 'react'
import { Alert, Button, CloseButton, Loader, ScrollArea, Text } from '@mantine/core'
import { IconBolt, IconCheck, IconInfoCircle, IconSend, IconX } from '@tabler/icons-react'
import { ATS_LABEL, type ApplySession, type FieldReport } from '@shared/apply-types'
import { api, errorText } from '../../api'
import { MonoLabel, StatusPill, toneStyle } from '../../components/ui'
import { AnswerControl } from './AnswerControl'
import { badgeOf, canAnswer, GROUP_TONE, groupReport, isAiAnswer, STATUS_META, stepLabel, suggestionNote } from './apply-report'
import classes from './browser.module.css'

/**
 * Auto-apply beside the page: what was detected, filled and uploaded, what is
 * left to the user (grouped as Needs you / AI answers — check these / Filled / Your choice, with the
 * inline "answer once" control), and "Mark as applied" once the site
 * confirms. Shown only while a session exists. It sits next to the native
 * page view (never over it), so it uses no tooltips or popovers that could
 * extend into the page.
 */
export function ApplyPanel({ activeTabId }: { activeTabId: string | null }) {
  const [session, setSession] = useState<ApplySession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [marked, setMarked] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const off = api.on('apply:session', (next) => {
      setSession(next)
      if (next?.status !== 'submitted-detected') setDismissed(false)
    })
    void api.apply.current().then(setSession)
    return off
  }, [])

  const id = session?.id
  useEffect(() => {
    setMarked(null)
    setError(null)
  }, [id])

  if (!session) return null

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const s = session
  const status = STATUS_META[s.status]
  // Once the site confirms (or the tab is gone) the form report is history.
  const submitted = s.status === 'submitted-detected'
  const stale = submitted || s.status === 'closed'
  const groups = stale ? [] : groupReport(s.report)
  const step = stepLabel(s.step)
  const canFill = s.status !== 'closed' && s.status !== 'filling' && s.status !== 'opened'
  const live = s.status === 'filling' || s.status === 'opened'
  const showFill = !submitted || dismissed
  const showTab = s.tabId !== activeTabId && s.status !== 'closed'

  return (
    <aside className={classes.panel} aria-label="Apply panel">
      <div className={classes.panelHead}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MonoLabel component="div">Apply</MonoLabel>
          <p className={classes.panelTitle} title={s.title}>
            {s.title}
          </p>
        </div>
        <CloseButton
          size="lg"
          icon={<IconX size={16} />}
          aria-label="End apply session"
          onClick={() => void run(() => api.apply.cancel(s.id))}
        />
      </div>
      <ScrollArea style={{ flex: 1 }} type="scroll">
        <div className={classes.panelBody}>
          <div className={classes.pills}>
            <StatusPill tone={status.tone} dot={!live} leftSection={live ? <Loader size={10} color="currentColor" /> : undefined}>
              {status.label}
            </StatusPill>
            {s.ats && (
              <StatusPill variant="outline" title={ATS_LABEL[s.ats]}>
                {ATS_LABEL[s.ats]}
              </StatusPill>
            )}
            {step && !stale && <StatusPill title={step}>{step}</StatusPill>}
          </div>

          {s.message && !submitted && <p className={classes.statusLine}>{s.message}</p>}

          <div className={classes.info}>
            <IconInfoCircle size={18} className={classes.infoIcon} aria-hidden />
            <p>
              Huntgry never submits. Review the form, answer the remaining questions and press the site&apos;s Submit button
              yourself.
            </p>
          </div>

          {error && (
            <Alert color="red" variant="light" p="xs" withCloseButton onClose={() => setError(null)}>
              <Text size="xs">{error}</Text>
            </Alert>
          )}

          {submitted && dismissed && (
            <p className={classes.statusLine}>This looked like a confirmation page. If the form is still open, press Fill form.</p>
          )}
          {submitted && !dismissed && (
            <div className={classes.confirm}>
              <p className={classes.confirmText}>
                <IconCheck size={16} className={classes.confirmIcon} aria-hidden />
                <span>{marked ? `Marked as applied on ${marked}.` : 'The site says the application was submitted.'}</span>
              </p>
              {marked ? (
                <Button size="xs" variant="default" onClick={() => void run(() => api.apply.cancel(s.id))}>
                  Done
                </Button>
              ) : (
                <div className={classes.actions}>
                  <Button
                    variant="primary"
                    className={classes.grow}
                    loading={busy}
                    onClick={() =>
                      void run(async () => {
                        const record = await api.applications.updateTracking(s.applicationId, { status: 'applied' })
                        setMarked(record.tracking.appliedAt ?? 'today')
                      })
                    }
                  >
                    Mark as applied
                  </Button>
                  <Button variant="default" onClick={() => setDismissed(true)}>
                    Not yet
                  </Button>
                </div>
              )}
            </div>
          )}

          {(showFill || showTab) && (
            <div className={classes.actions}>
              {showFill &&
                (s.status === 'closed' ? (
                  <Button
                    variant="primary"
                    className={classes.grow}
                    leftSection={<IconSend size={16} />}
                    loading={busy}
                    onClick={() => void run(() => api.apply.start(s.applicationId))}
                  >
                    Open again
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className={classes.grow}
                    leftSection={<IconBolt size={16} />}
                    disabled={!canFill}
                    loading={busy || s.status === 'filling'}
                    onClick={() => void run(() => api.apply.fill(s.id))}
                  >
                    {s.report ? 'Fill again' : 'Fill form'}
                  </Button>
                ))}
              {showTab && (
                <Button
                  variant="default"
                  className={showFill ? undefined : classes.grow}
                  onClick={() => void run(() => api.browser.activate(s.tabId))}
                >
                  Show tab
                </Button>
              )}
            </div>
          )}
          {s.report && !stale && (
            <p className={classes.caption}>Fill again only fills empty fields and attaches the PDFs again; your own edits stay.</p>
          )}

          {groups.map((group) => (
            <section key={group.title} className={classes.group} aria-label={group.title}>
              <div className={classes.groupHead}>
                <MonoLabel>{group.title}</MonoLabel>{' '}
                <span className={classes.count} style={toneStyle(GROUP_TONE[group.title])}>
                  {group.fields.length}
                </span>
              </div>
              {group.fields.map((f, i) => (
                <ReportRow key={`${f.label}-${i}`} field={f} sessionId={s.id} filling={s.status === 'filling'} />
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
    </aside>
  )
}

/**
 * One line of the field report. The label's parent holds the outcome pill and
 * its grandparent is the whole line (e2e/pages/browser.ts `field()` relies on that).
 */
function ReportRow({ field: f, sessionId, filling }: { field: FieldReport; sessionId: string; filling: boolean }) {
  const meta = badgeOf(f)
  const note = suggestionNote(f)
  const detail = f.outcome === 'filled' || f.outcome === 'uploaded' || f.outcome === 'kept' ? f.value : f.reason
  return (
    <div className={classes.row}>
      <div className={classes.rowHead}>
        <span className={classes.rowLabel} title={f.label || undefined}>
          {f.label || '(no label)'}
          {f.required && <span className={classes.required}> *</span>}
        </span>
        <StatusPill tone={meta.tone} className={classes.rowPill}>
          {meta.label}
        </StatusPill>
      </div>
      {(f.value || f.reason) && <p className={classes.rowText}>{detail}</p>}
      {((f.suggestedBy === 'draft' && f.outcome === 'filled') || isAiAnswer(f)) && f.reason && (
        <p className={classes.rowText} data-tone="review">
          {f.reason}
        </p>
      )}
      {/* A value Huntgry wrote over the site's own guess (#136: "Replaced the site's parsed value."). */}
      {f.outcome === 'filled' && f.reason && f.suggestedBy !== 'draft' && !isAiAnswer(f) && <p className={classes.rowText}>{f.reason}</p>}
      {note && (
        <p className={classes.rowText} data-lines="3">
          {note}
        </p>
      )}
      {canAnswer(f) && (
        <AnswerControl key={`${f.fieldId}|${f.question}|${f.suggestion ?? ''}`} sessionId={sessionId} field={f} disabled={filling} />
      )}
    </div>
  )
}
