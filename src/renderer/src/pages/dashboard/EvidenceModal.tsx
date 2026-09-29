import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'
import { IconSparkles } from '@tabler/icons-react'
import type { EvidenceTarget, GapInsight } from '@shared/insights-types'
import type { MasterProfile, ProfileDocument } from '@shared/master-profile'
import { applyEvidence } from '@shared/profile-insights'
import { api, errorText } from '../../api'

interface Props {
  gap: GapInsight | null
  onClose(): void
  /** Called after the master profile was saved with the new evidence. */
  onSaved(): void
}

function parseTarget(value: string, category: string): EvidenceTarget {
  if (value === 'skills') return { kind: 'skills', category }
  const [kind, index] = value.split(':')
  return { kind: kind as 'experience' | 'project', index: Number(index) }
}

/** The lines the change adds, shown before anything is written. */
function changeLines(before: MasterProfile, after: MasterProfile, t: EvidenceTarget): string[] {
  if (t.kind === 'skills') {
    const added = after.skills.find((g, i) => JSON.stringify(g) !== JSON.stringify(before.skills[i]))
    return added ? [`Skills · ${added.category}: ${added.items.join(', ')}`] : []
  }
  const pick = (p: MasterProfile) => (t.kind === 'experience' ? p.experience[t.index] : p.projects[t.index])
  const a = pick(before)
  const b = pick(after)
  const out: string[] = []
  if (a.technologies !== b.technologies) out.push(`Technologies: ${b.technologies}`)
  for (const h of b.highlights.filter((h) => !a.highlights.includes(h))) out.push(`- ${h}`)
  return out
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

  useEffect(() => {
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
        setDoc(d)
        setTarget(d.profile.experience.length > 0 ? 'experience:0' : d.profile.projects.length > 0 ? 'project:0' : 'skills')
        setCategory(d.profile.skills[0]?.category ?? 'Other')
      })
      .catch((e) => setError(errorText(e)))
  }, [gap])

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
    if (!doc || !t || !gap) return { lines: [] as string[], error: null as string | null, next: null as MasterProfile | null }
    try {
      const next = applyEvidence(doc.profile, { skill: gap.skill, target: t, bullet, addTechnology: t.kind === 'skills' || addTechnology })
      return { lines: changeLines(doc.profile, next, t), error: null, next }
    } catch (e) {
      return { lines: [], error: errorText(e), next: null }
    }
  }, [doc, target, category, bullet, addTechnology, gap])

  async function draft() {
    if (!gap || !t) return
    setDrafting(true)
    setError(null)
    setWarning(null)
    try {
      const d = await api.insights.draft({ skill: gap.skill, target: t, notes })
      setBullet(d.bullet)
      if (d.unsupportedNumbers.length > 0) {
        setWarning(
          `The draft has numbers your notes do not: ${d.unsupportedNumbers.join(', ')}. Remove them unless they are true and you can defend them.`
        )
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setDrafting(false)
    }
  }

  async function save() {
    if (!doc || !preview.next) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.profile.save(preview.next, doc.version)
      if (!res.ok) {
        setError(res.conflict ? 'master-profile.md changed since this opened. Close and try again.' : res.error)
        return
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const entryTarget = t && t.kind !== 'skills'
  return (
    <Modal opened={gap !== null} onClose={onClose} title={gap ? `Add evidence for ${gap.skill}` : ''} size="lg" centered>
      {!doc && !error && <Loader size="sm" />}
      {doc && gap && (
        <Stack gap="sm">
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
                autosize
                minRows={2}
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
              />
              <Group justify="flex-end">
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconSparkles size={14} />}
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
                autosize
                minRows={2}
                maxLength={300}
                value={bullet}
                onChange={(e) => setBullet(e.currentTarget.value)}
              />
              <Checkbox
                label={`List ${gap.skill} in this entry's technologies`}
                checked={addTechnology}
                onChange={(e) => setAddTechnology(e.currentTarget.checked)}
              />
            </>
          )}
          {warning && (
            <Alert color="yellow" variant="light">
              {warning}
            </Alert>
          )}
          <div>
            <Text size="sm" fw={600} mb={4}>
              Change to master-profile.md
            </Text>
            {preview.lines.length > 0 ? (
              <Code block>{preview.lines.map((l) => `+ ${l}`).join('\n')}</Code>
            ) : (
              <Text size="sm" c="dimmed">
                {preview.error ?? 'Nothing to change: it is already there.'}
              </Text>
            )}
          </div>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!preview.next || preview.lines.length === 0}>
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
