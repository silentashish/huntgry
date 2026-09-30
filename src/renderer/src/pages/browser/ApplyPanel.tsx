import { useEffect, useState } from 'react'
import { Alert, Badge, Box, Button, CloseButton, Divider, Group, Loader, ScrollArea, Stack, Text } from '@mantine/core'
import { IconCheck, IconInfoCircle, IconRefresh, IconSend } from '@tabler/icons-react'
import { ATS_LABEL, type ApplySession } from '@shared/apply-types'
import { api, errorText } from '../../api'
import { groupReport, OUTCOME_META, STATUS_META } from './apply-report'

/**
 * Auto-apply beside the page: what was detected, filled and uploaded, what is
 * left to the user, and "Mark as applied" once the site confirms. Shown only
 * while a session exists. It sits next to the native page view (never over
 * it), so it uses no tooltips or popovers that could extend into the page.
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
  const canFill = s.status !== 'closed' && s.status !== 'filling' && s.status !== 'opened'

  return (
    <Box
      w={340}
      style={{
        flexShrink: 0,
        borderLeft: '1px solid var(--mantine-color-default-border)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Group justify="space-between" wrap="nowrap" px="sm" py={8}>
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text fw={600} size="sm">
            Apply
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {s.title}
          </Text>
        </Stack>
        <CloseButton size="sm" aria-label="End apply session" onClick={() => void run(() => api.apply.cancel(s.id))} />
      </Group>
      <Divider />
      <ScrollArea style={{ flex: 1 }} px="sm" py="sm">
        <Stack gap="sm">
          <Group gap={6}>
            <Badge
              color={status.color}
              variant="light"
              leftSection={
                s.status === 'filling' || s.status === 'opened' ? <Loader size={10} color={status.color} /> : undefined
              }
            >
              {status.label}
            </Badge>
            {s.ats && (
              <Badge color="gray" variant="outline">
                {ATS_LABEL[s.ats]}
              </Badge>
            )}
          </Group>

          <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
            <Text size="xs">
              Huntgry never submits. Review the form, answer the remaining questions and press the site&apos;s Submit
              button yourself.
            </Text>
          </Alert>

          {s.message && !submitted && <Text size="xs">{s.message}</Text>}
          {error && (
            <Alert color="red" variant="light" p="xs" withCloseButton onClose={() => setError(null)}>
              <Text size="xs">{error}</Text>
            </Alert>
          )}

          {s.tabId !== activeTabId && s.status !== 'closed' && (
            <Button size="xs" variant="light" onClick={() => void run(() => api.browser.activate(s.tabId))}>
              Show the apply tab
            </Button>
          )}

          {submitted && dismissed && (
            <Text size="xs">This looked like a confirmation page. If the form is still open, press Fill form.</Text>
          )}
          {submitted && !dismissed && (
            <Alert color="teal" variant="light" p="xs" icon={<IconCheck size={16} />}>
              {marked ? (
                <Stack gap={6}>
                  <Text size="xs">Marked as applied on {marked}.</Text>
                  <Button size="xs" variant="default" onClick={() => void run(() => api.apply.cancel(s.id))}>
                    Done
                  </Button>
                </Stack>
              ) : (
                <Stack gap={6}>
                  <Text size="xs">The site says the application was submitted.</Text>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      color="teal"
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
                    <Button size="xs" variant="default" onClick={() => setDismissed(true)}>
                      Not yet
                    </Button>
                  </Group>
                </Stack>
              )}
            </Alert>
          )}

          {(!submitted || dismissed) && (
            <Group gap="xs">
              {s.status === 'closed' ? (
                <Button
                  size="xs"
                  leftSection={<IconSend size={14} />}
                  loading={busy}
                  onClick={() => void run(() => api.apply.start(s.applicationId))}
                >
                  Open again
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant={s.status === 'filled' ? 'default' : 'filled'}
                  leftSection={s.status === 'filled' ? <IconRefresh size={14} /> : <IconSend size={14} />}
                  disabled={!canFill}
                  loading={busy || s.status === 'filling'}
                  onClick={() => void run(() => api.apply.fill(s.id))}
                >
                  {s.report ? 'Fill again' : 'Fill form'}
                </Button>
              )}
            </Group>
          )}
          {s.report && !stale && (
            <Text size="xs" c="dimmed">
              Fill again only fills empty fields and attaches the PDFs again; your own edits stay.
            </Text>
          )}

          {groups.map((group) => (
            <Stack key={group.title} gap={4}>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                {group.title} ({group.fields.length})
              </Text>
              {group.fields.map((f, i) => {
                const meta = OUTCOME_META[f.outcome]
                return (
                  <Box key={`${f.label}-${i}`} py={2}>
                    <Group gap={6} wrap="nowrap" justify="space-between">
                      <Text size="xs" truncate style={{ minWidth: 0 }}>
                        {f.label || '(no label)'}
                        {f.required && (
                          <Text span c="red" size="xs">
                            {' '}
                            *
                          </Text>
                        )}
                      </Text>
                      <Badge size="xs" variant="light" color={meta.color} style={{ flexShrink: 0 }}>
                        {meta.label}
                      </Badge>
                    </Group>
                    {(f.value || f.reason) && (
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {f.outcome === 'filled' || f.outcome === 'uploaded' || f.outcome === 'kept'
                          ? f.value
                          : f.reason}
                      </Text>
                    )}
                  </Box>
                )
              })}
            </Stack>
          ))}
        </Stack>
      </ScrollArea>
    </Box>
  )
}
