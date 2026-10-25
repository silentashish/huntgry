import { useEffect, useState } from 'react'
import { Alert, Button, Text } from '@mantine/core'
import { IconSend } from '@tabler/icons-react'
import type { AutomationCandidate, PreparedFill } from '@shared/automation-types'
import { api, errorText } from '../../api'
import { ScoreRing, SectionCard, StatusPill } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { badgeOf } from '../browser/apply-report'
import { aiLines, openRequiredLines } from './view'
import classes from './automation.module.css'

/**
 * A Ready to submit job (#154): the match, links to its resume, cover letter and review notes (on Review), what
 * the unattended fill wrote, AI answers and drafts badged, and "Review & submit": the user's approval, then the
 * filled form in the Browser. The Submit stays theirs.
 */
export function ReadyCard({ candidate: c, onError }: { candidate: AutomationCandidate; onError(message: string): void }) {
  const { navigate } = useNavigation()
  const [fill, setFill] = useState<PreparedFill | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.automation.prepared(c.key).then(
      (f) => live && setFill(f),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [c.key, c.prepared?.preparedAt])

  async function open() {
    setBusy(true)
    setError(null)
    try {
      await api.automation.openPrepared(c.key)
      navigate('browser')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function dismiss() {
    try {
      await api.automation.dismiss(c.key)
    } catch (err) {
      onError(errorText(err))
    }
  }

  const p = c.prepared
  const ai = aiLines(fill?.report)
  const open_ = openRequiredLines(fill?.report)
  return (
    <article aria-label={`Ready to submit: ${c.title} · ${c.company}`}>
    <SectionCard accent="ember" padding="md">
      <div className={classes.readyHead}>
        {c.match ? <ScoreRing size="sm" value={c.match.score} aria-label={`Match ${c.match.score} of 100`} /> : null}
        <div style={{ minWidth: 0 }}>
          <h4 className={classes.readyTitle}>{c.title}</h4>
          <Text size="sm" c="dimmed">
            {c.company}
          </Text>
        </div>
      </div>
      {p && (
        <div className={classes.facts}>
          <StatusPill tone="trail">{`${p.filled} filled`}</StatusPill>
          <StatusPill tone="review">{`${p.ai} by AI`}</StatusPill>
          <StatusPill tone={p.openRequired ? 'warning' : 'neutral'}>{`${p.openRequired} required left`}</StatusPill>
          {p.uploadsDeferred > 0 && <StatusPill tone="neutral">{`${p.uploadsDeferred} file${p.uploadsDeferred === 1 ? '' : 's'} attached when you open it`}</StatusPill>}
        </div>
      )}
      {ai.length > 0 && (
        <ul className={classes.aiList} aria-label="AI answers — check these">
          {ai.map((f, i) => {
            const badge = badgeOf(f)
            return (
              <li key={`${f.fieldId ?? f.label}-${i}`} className={classes.aiItem}>
                <StatusPill tone={badge.tone}>{badge.label}</StatusPill>
                <span className={classes.aiLabel}>{f.label}</span>
                <span className={classes.aiValue} title={f.value}>
                  {f.value}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {open_.length > 0 && (
        <Text size="xs" c="dimmed" mt="xs">
          Left for you: {open_.map((f) => f.label).join(', ')}
        </Text>
      )}
      {error && (
        <Alert color="danger" variant="light" mt="sm" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <div className={classes.actions}>
        <Button variant="primary" size="xs" leftSection={<IconSend size={14} />} loading={busy} onClick={() => void open()}>
          Review & submit
        </Button>
        {c.applicationId && (
          <Button variant="default" size="xs" onClick={() => navigate('review', { applicationId: c.applicationId })}>
            Resume, cover letter & notes
          </Button>
        )}
        <Button variant="subtle" color="gray" size="xs" onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
    </SectionCard>
    </article>
  )
}
