import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Center, Grid, Group, Loader, NavLink, Stack, Text, Title } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { REVIEW_STATE_LABEL, type ReviewDetail, type ReviewItem } from '@shared/review-types'
import { api, errorText } from '../../api'
import { useNavigation, type PageParams } from '../../navigation'
import { ReviewDetailView } from './ReviewDetail'

/**
 * Unattended results (#31): everything the pipeline built that nobody has
 * looked at yet. Approve (optionally saving reframings as standing
 * approvals), re-run with answers, or discard; each bound to the revision
 * that was shown.
 */
export function ReviewPage({ params }: { params: PageParams['review'] }) {
  const { navigate } = useNavigation()
  const [items, setItems] = useState<ReviewItem[] | null>(null)
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

  // Reflect a decision: reload the list and the detail (a re-run keeps it open).
  async function decided(next: ReviewDetail) {
    setDetail(next)
    await load()
    if (next.state === 'approved' || next.state === 'discarded') {
      const rest = (await api.review.list()).filter((i) => i.applicationId !== next.applicationId)
      await open(rest[0]?.applicationId ?? null)
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Review</Title>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="light" onClick={() => navigate('settings')}>
            Standing approvals
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        Unattended runs use only your profile facts and your standing approvals; everything else they left out is
        listed here. Approve a result to unlock Apply, re-run it with your answers, or discard it.
      </Text>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {items === null && !error && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {items && items.length === 0 && !selected && (
        <Card withBorder radius="md" padding="xl">
          <Stack align="center" gap="xs" py="lg">
            <Title order={3}>Nothing to review</Title>
            <Text c="dimmed" ta="center" maw={520}>
              Results of unattended pipelines land here until you approve them. Start one from the Jobs page with
              "Tailor all → Run unattended".
            </Text>
            <Button mt="sm" onClick={() => navigate('jobs')}>
              Find jobs
            </Button>
          </Stack>
        </Card>
      )}

      {items && (items.length > 0 || selected) && (
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card withBorder radius="md" padding="xs">
              <Stack gap={2}>
                {items.map((i) => {
                  const meta = REVIEW_STATE_LABEL[i.state]
                  return (
                    <NavLink
                      key={i.applicationId}
                      active={selected === i.applicationId}
                      label={i.title}
                      description={
                        <Group gap={6} mt={2}>
                          <Badge size="xs" variant="light" color={meta.color}>
                            {meta.label}
                          </Badge>
                          {i.build.status === 'fail' && (
                            <Badge size="xs" variant="light" color="red">
                              build failed
                            </Badge>
                          )}
                          <Text size="xs" c="dimmed">
                            {new Date(i.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                          </Text>
                        </Group>
                      }
                      onClick={() => void open(i.applicationId)}
                      style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                    />
                  )
                })}
                {items.length === 0 && (
                  <Text size="sm" c="dimmed" p="xs">
                    Nothing else to review.
                  </Text>
                )}
              </Stack>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 8 }}>
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
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  )
}
