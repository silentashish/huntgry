/**
 * Jobs (#40, Figma `19:444` / `19:1114`): the saved jobs from `jobs.list`, 50 per page by
 * cursor, dismissed ones flagged; search; **Add by URL** (`jobs.addUrl`, the package refuses
 * local, private and non-http(s) links before anything is sent); pick jobs and queue them, or
 * run them unattended with the start sheet (#41).
 */

import { REMOTE_MAX_JOBS, type RemoteJob } from '@huntgry/remote-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { useModel, useRemote } from '../state/RemoteProvider'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { Checkbox, Field } from '../ui/Controls'
import { FadeIn } from '../ui/FadeIn'
import { Icon } from '../ui/Icon'
import { Screen, ScreenHeader } from '../ui/Screen'
import { radius, useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'
import { PipelineStartSheet } from './PipelineStartSheet'

/** The 36 pt ring of the Figma card: tailored jobs in ember with a check, the others with the company's initial. */
function Mark({ job }: { job: RemoteJob }) {
  const colors = useColors()
  const on = !!job.tailored
  return (
    <View style={{ width: 36, height: 36, borderRadius: radius.full, borderWidth: 2, borderColor: on ? colors.accentPrimary : colors.borderStrong, backgroundColor: on ? colors.accentPrimarySoft : colors.bgSubtle, alignItems: 'center', justifyContent: 'center' }}>
      {on ? (
        <Icon name="check" size={16} color={colors.textAccent} stroke={2} />
      ) : (
        <Txt variant="labelMd">{(job.company ?? job.title).trim().charAt(0).toUpperCase() || '·'}</Txt>
      )}
    </View>
  )
}

function JobCard({ job, selected, onToggle, index }: { job: RemoteJob; selected: boolean; onToggle: () => void; index: number }) {
  // A board's name says where it came from; "url" / "pasted" add nothing.
  const source = job.source && job.source !== 'url' && job.source !== 'pasted' ? job.source : undefined
  const sub = [job.company, job.location, source].filter(Boolean).join(' · ')
  return (
    <FadeIn index={index}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`${job.title}${job.company ? `, ${job.company}` : ''}${job.tailored ? ', tailored' : ''}${job.dismissed ? ', dismissed' : ''}`} onPress={onToggle}>
        {({ pressed }) => (
          <Card padding={12} style={[pressed ? { opacity: 0.9 } : null, job.dismissed ? { opacity: 0.6 } : null]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Mark job={job} />
              <View style={{ flex: 1, gap: 1, minWidth: 0 }}>
                <Txt variant="labelMd" numberOfLines={1}>
                  {job.title}
                </Txt>
                {sub ? (
                  <Txt variant="bodyXs" color="textSecondary" numberOfLines={1}>
                    {sub}
                  </Txt>
                ) : null}
                {job.dismissed ? (
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                    <Badge tone="neutral" label="Dismissed on your Mac" />
                  </View>
                ) : null}
              </View>
              <Checkbox checked={selected} />
            </View>
          </Card>
        )}
      </Pressable>
    </FadeIn>
  )
}

export function JobsScreen() {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const [url, setUrl] = useState('')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [sheet, setSheet] = useState(false)
  const jobs = snap.jobs
  useFocusEffect(
    useCallback(() => {
      if (!model.getSnapshot().jobs) model.loadJobs('')
    }, [model])
  )
  // Search as you type, a beat after the last key.
  useEffect(() => {
    if (query.trim() === (model.getSnapshot().jobs?.filter ?? '')) return
    const t = setTimeout(() => model.loadJobs(query), 350)
    return () => clearTimeout(t)
  }, [model, query])
  const adding = snap.commands.some((c) => c.name === 'jobs.addUrl' && (c.state === 'sending' || c.state === 'sent'))
  const add = () => {
    if (url.trim() && model.addJobUrl(url)) setUrl('')
  }
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= REMOTE_MAX_JOBS ? s : [...s, id]))
  const items = jobs?.items ?? []
  const tailored = items.filter((j) => j.tailored).length
  const n = selected.length
  // The Figma "Queue N selected", pinned under the list so it stays in reach, with the start sheet next to it.
  const footer =
    n > 0 ? (
      <View style={{ gap: 8 }}>
        <Button
          variant="primary"
          size="md"
          icon="sparkles"
          label={`Queue ${n} selected`}
          onPress={() => {
            if (model.enqueueJobs(selected)) setSelected([])
          }}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button grow variant="outline" size="md" icon="cpu" label={`Run ${n} unattended…`} onPress={() => setSheet(true)} />
          <Button variant="ghost" size="md" label="Clear" onPress={() => setSelected([])} />
        </View>
      </View>
    ) : undefined
  return (
    <Screen scroll footer={footer}>
      <ScreenHeader
        eyebrow={jobs ? `${items.length}${jobs.nextCursor ? '+' : ''} saved · ${tailored} tailored` : 'Saved jobs'}
        title="Jobs"
        right={
          <IconButton
            icon={searching ? 'x' : 'filter'}
            label={searching ? 'Close search' : 'Search saved jobs'}
            onPress={() => {
              if (searching) {
                setQuery('')
                model.loadJobs('')
              }
              setSearching(!searching)
            }}
          />
        }
      />
      {searching ? <Field icon="search" placeholder="Search title, company or place" value={query} onChangeText={setQuery} autoFocus autoCapitalize="none" returnKeyType="search" accessibilityLabel="Search saved jobs" /> : null}
      <Field
        icon="link"
        placeholder="Add a job by URL"
        value={url}
        onChangeText={setUrl}
        onSubmitEditing={add}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        accessibilityLabel="Add a job by URL"
        right={url.trim() ? <Button variant="primary" label="Add" busy={adding} onPress={add} /> : adding ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      />
      {items.map((job, i) => (
        <JobCard key={job.id} job={job} index={i} selected={selected.includes(job.id)} onToggle={() => toggle(job.id)} />
      ))}
      {jobs && !jobs.loading && items.length === 0 && !jobs.error ? (
        <Card>
          <Txt variant="bodySm" color="textSecondary">
            {jobs.filter ? `No saved job matches “${jobs.filter}”.` : 'No saved jobs yet. Add one by URL above, or save jobs on your Mac.'}
          </Txt>
        </Card>
      ) : null}
      {jobs?.error ? (
        <Txt variant="bodyXs" color="danger">
          {jobs.error}
        </Txt>
      ) : null}
      {jobs?.loading ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Txt variant="bodyXs" color="textMuted">
            Loading saved jobs…
          </Txt>
        </View>
      ) : jobs?.nextCursor ? (
        <Button variant="secondary" size="md" icon="chevron-down" label="Load 50 more" onPress={() => model.loadJobs(jobs.filter, true)} />
      ) : null}
      <PipelineStartSheet
        visible={sheet}
        jobIds={selected}
        onClose={() => setSheet(false)}
        onStarted={() => {
          setSheet(false)
          setSelected([])
          router.navigate('/pipeline')
        }}
      />
    </Screen>
  )
}
