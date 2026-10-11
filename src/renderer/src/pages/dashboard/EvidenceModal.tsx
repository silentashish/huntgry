import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconSparkles } from '@tabler/icons-react'
import type { EvidenceTarget, GapInsight } from '@shared/insights-types'
import type { MasterProfile, ProfileDocument } from '@shared/master-profile'
import { applyEvidence } from '@shared/profile-insights'
import { api, errorText } from '../../api'
import classes from './dashboard.module.css'
import { changeLines } from './evidence'

interface Props {
  gap: GapInsight | null
  onClose(): void
  /** Called after the master profile was saved with the new evidence. */
  onSaved(): void
}

/** Figma: the modal title in the display face. */
const MODAL_STYLES = {
  title: { fontFamily: 'var(--hg-font-display)', fontSize: 24, lineHeight: '30px', fontWeight: 700, letterSpacing: '-0.01em' }
} as const

function parseTarget(value: string, category: string): EvidenceTarget {
  if (value === 'skills') return { kind: 'skills', category }
  const [kind, index] = value.split(':')
  return { kind: kind as 'experience' | 'project', index: Number(index) }
}

/**
 * "I have this": the user says where they used a skill and in what words,
 * optionally with Claude wording a bullet from their notes. The change is
 * previewed, then saved through the profile's version-checked save.
 */
export function EvidenceModal({ gap, onClose, onSaved }: Props) {
  const [doc, setDoc] = useState<ProfileDocument | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [category, setCategory] = useState('')
  const [bullet, setBullet] = useState('')
  const [addTechnology, setAddTechnology] = useState(true)
  const [notes, setNotes] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Each opening is a session; results of reads, drafts and saves from an earlier one are dropped.
  const session = useRef(0)

  useEffect(() => {
    const mine = ++session.current
    if (!gap) return
    setDoc(null)
    setTarget(null)
    setCategory('')
    setBullet('')
    setNotes('')
    setAddTechnology(true)
    setWarning(null)
    setError(null)
    api.profile
      .read()
      .then((d) => {
        if (session.current !== mine) return
        setDoc(d)
        setTarget(d.profile.experience.length > 0 ? 'experience:0' : d.profile.projects.length > 0 ? 'project:0' : 'skills')
        setCategory(d.profile.skills[0]?.category ?? 'Other')
      })
      .catch((e) => session.current === mine && setError(errorText(e)))
  }, [gap])

  function close() {
    session.current++
    onClose()
  }

  const options = useMemo(() => {
    if (!doc) return []
    const p = doc.profile
    return [
      {
        group: 'Experience',
        items: p.experience.map((e, i) => ({
          value: `experience:${i}`,
          label: [e.role, e.company].filter(Boolean).join(' · ') || `Experience ${i + 1}`
        }))
      },
      { group: 'Projects', items: p.projects.map((pr, i) => ({ value: `project:${i}`, label: pr.name || `Project ${i + 1}` })) },
      { group: 'Skills', items: [{ value: 'skills', label: 'Only list it in my skills' }] }
    ].filter((g) => g.items.length > 0)
  }, [doc])

  const t = target ? parseTarget(target, category) : null
  const preview = useMemo(() => {
    const none = { context: [] as string[], lines: [] as string[], error: null as string | null, next: null as MasterProfile | null }
    if (!doc || !t || !gap) return none
    try {
      const next = applyEvidence(doc.profile, { skill: gap.skill, target: t, bullet, addTechnology: t.kind === 'skills' || addTechnology })
      const change = changeLines(doc.profile, next, t)
      return { context: change.context, lines: change.added, error: null, next }
    } catch (e) {
      return { ...none, error: errorText(e) }
    }
  }, [doc, target, category, bullet, addTechnology, gap])

  async function draft() {
    if (!gap || !t) return
    const mine = session.current
    setDrafting(true)
    setError(null)
    setWarning(null)
    try {
      const d = await api.insights.draft({ skill: gap.skill, target: t, notes })
      if (session.current !== mine) return
      setBullet(d.bullet)
      if (d.unsupportedNumbers.length > 0) {
        setWarning(
          `The draft has numbers your notes do not: ${d.unsupportedNumbers.join(', ')}. Remove them unless they are true and you can defend them.`
        )
      }
    } catch (e) {
      if (session.current === mine) setError(errorText(e))
    } finally {
      if (session.current === mine) setDrafting(false)
    }
  }

  async function save() {
    if (!doc || !preview.next) return
    const mine = session.current
    setSaving(true)
    setError(null)
    try {
      const res = await api.profile.save(preview.next, doc.version)
      // The profile was written either way; only this session's form reacts.
      if (res.ok) onSaved()
      if (session.current !== mine) return
      if (!res.ok) {
        setError(res.conflict ? 'master-profile.md changed since this opened. Close and try again.' : res.error)
        return
      }
      close()
    } catch (e) {
      if (session.current === mine) setError(errorText(e))
    } finally {
      if (session.current === mine) setSaving(false)
    }
  }

  const entryTarget = t && t.kind !== 'skills'
  return (
    <Modal opened={gap !== null} onClose={close} title={gap ? `Add evidence for ${gap.skill}` : ''} size={620} centered styles={MODAL_STYLES}>
      {!doc && !error && <Loader size="sm" />}
      {doc && gap && (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Only add what you actually did: every resume is picked from the master profile, and you will have to defend
            each line.
          </Text>
          <Select label="Where did you use it?" data={options} value={target} onChange={setTarget} allowDeselect={false} />
          {t?.kind === 'skills' && (
            <TextInput
              label="Skill group"
              value={category}
              onChange={(e) => setCategory(e.currentTarget.value)}
              description="An existing group, or a new one."
            />
          )}
          {entryTarget && (
            <>
              <Textarea
                label="Your notes (for Claude)"
                description="What you did with it, in your own words. Claude only rewords this; it adds nothing."
                inputWrapperOrder={['label', 'input', 'description', 'error']}
                autosize
                minRows={3}
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
              />
              <Group>
                <Button
                  variant="light"
                  color="trail"
                  leftSection={<IconSparkles size={16} />}
                  loading={drafting}
                  disabled={notes.trim().length < 10}
                  onClick={draft}
                >
                  Draft a bullet with Claude
                </Button>
              </Group>
              <Textarea
                label="Highlight to add"
                description="Optional. Write it yourself or edit Claude's draft."
                inputWrapperOrder={['label', 'input', 'description', 'error']}
                autosize
                minRows={2}
                maxLength={300}
                value={bullet}
                onChange={(e) => setBullet(e.currentTarget.value)}
              />
              {warning && (
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>
                  {warning}
                </Alert>
              )}
              <Checkbox
                label={`List ${gap.skill} in this entry's technologies`}
                checked={addTechnology}
                onChange={(e) => setAddTechnology(e.currentTarget.checked)}
              />
            </>
          )}
          <div className={classes.diff}>
            <div className={classes.diffTitle}>Change to master-profile.md</div>
            {preview.lines.length > 0 ? (
              <>
                {preview.context.map((l) => (
                  <div key={`c-${l}`} className={classes.diffContext}>{`  ${l}`}</div>
                ))}
                {preview.lines.map((l) => (
                  <div key={`a-${l}`} className={classes.diffAdd}>{`+ ${l}`}</div>
                ))}
              </>
            ) : (
              <div className={classes.diffContext}>{preview.error ?? 'Nothing to change: it is already there.'}</div>
            )}
          </div>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="subtle" onClick={close}>
              Cancel
            </Button>
            <Button leftSection={<IconCheck size={16} />} onClick={save} loading={saving} disabled={!preview.next || preview.lines.length === 0}>
              Save to master profile
            </Button>
          </Group>
        </Stack>
      )}
      {!doc && error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
    </Modal>
  )
}
