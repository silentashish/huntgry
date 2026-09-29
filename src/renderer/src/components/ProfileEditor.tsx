import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  List,
  Menu,
  Modal,
  Paper,
  Spoiler,
  Stack,
  Tabs,
  Text,
  Title
} from '@mantine/core'
import { isProfileEmpty, type MasterProfile, type ProfileDocument } from '@shared/master-profile'
import { api, errorText } from '../api'
import {
  ContactSection,
  CredentialsSection,
  EducationSection,
  ExperienceSection,
  NotesSection,
  ProjectsSection,
  SummarySkillsSection
} from './profile/sections'

type Notice = { color: 'green' | 'red' | 'yellow' | 'blue'; title?: string; text: string; items?: string[] } | null

interface Props {
  document: ProfileDocument
  /** A draft to start from instead of the file content, e.g. a parsed resume. */
  initialDraft?: { profile: MasterProfile; fileName: string; warnings: string[] }
  onDocumentChange(doc: ProfileDocument): void
  onSwitchWorkspace(): void
  /** Called whenever the form starts or stops differing from the file. */
  onDirtyChange?(dirty: boolean): void
  /** Tab to open first, e.g. when another page deep-links into a section. */
  initialTab?: string
}

/**
 * The master profile form. Edits stay in memory until Save, which rewrites
 * the Markdown file; the file is re-read afterwards so the form always shows
 * exactly what is on disk.
 */
export function ProfileEditor({
  document: doc,
  initialDraft,
  onDocumentChange,
  onSwitchWorkspace,
  onDirtyChange,
  initialTab
}: Props) {
  const [draft, setDraft] = useState<MasterProfile>(initialDraft?.profile ?? doc.profile)
  const [notice, setNotice] = useState<Notice>(
    initialDraft
      ? {
          color: 'blue',
          title: `Imported from ${initialDraft.fileName}`,
          text: 'Review every section, then save. Nothing is written to master-profile.md until you do.',
          items: initialDraft.warnings
        }
      : null
  )
  const [busy, setBusy] = useState<'save' | 'import' | 'reload' | null>(null)
  const [conflict, setConflict] = useState(false)
  const [pendingImport, setPendingImport] = useState<{ profile: MasterProfile; fileName: string; warnings: string[] } | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [tab, setTab] = useState<string | null>(initialTab ?? 'contact')

  const dirty = useMemo(() => JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(doc.profile)), [draft, doc])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // Warn before the window closes with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  async function save() {
    setBusy('save')
    try {
      const result = await api.profile.save(draft, doc.version)
      if (result.ok) {
        onDocumentChange(result.document)
        setDraft(result.document.profile)
        setConflict(false)
        setNotice({ color: 'green', text: `Saved to ${fileName(result.document.path)}.` })
      } else {
        setConflict(result.conflict)
        setNotice({ color: 'red', text: result.error })
      }
    } catch (err) {
      setNotice({ color: 'red', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  async function reload() {
    setBusy('reload')
    try {
      const next = await api.profile.read()
      onDocumentChange(next)
      setDraft(next.profile)
      setConflict(false)
      setNotice({ color: 'blue', text: `Reloaded ${fileName(next.path)} from disk.` })
    } catch (err) {
      setNotice({ color: 'red', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  async function importResume() {
    setBusy('import')
    try {
      const result = await api.profile.importResume()
      if (!result.ok) {
        if (!result.cancelled) setNotice({ color: 'red', text: result.error ?? 'Could not read the resume.' })
        return
      }
      if (isProfileEmpty(draft)) applyImport(result)
      else setPendingImport(result)
    } catch (err) {
      setNotice({ color: 'red', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  function applyImport(result: { profile: MasterProfile; fileName: string; warnings: string[] }) {
    setDraft(result.profile)
    setPendingImport(null)
    setTab('contact')
    setNotice({
      color: 'blue',
      title: `Imported from ${result.fileName}`,
      text: 'Review every section, then save. Nothing is written to master-profile.md until you do.',
      items: result.warnings
    })
  }

  const c = draft.contact
  const counts = {
    experience: draft.experience.length,
    projects: draft.projects.length,
    education: draft.education.length,
    credentials: draft.certifications.length + draft.publications.length
  }

  return (
    <Stack gap="md">
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Title order={3}>{c.name.trim() || 'Your master profile'}</Title>
            {c.headline.trim() && <Text c="dimmed">{c.headline}</Text>}
            <Text size="sm" c="dimmed" truncate>
              {[c.location, c.email, c.phone].filter((v) => v.trim()).join(' · ') || 'Fill in your details below.'}
            </Text>
            <Group gap="xs" mt={6}>
              <Badge variant="light">{plural(counts.experience, 'role')}</Badge>
              <Badge variant="light">{plural(counts.projects, 'project')}</Badge>
              <Badge variant="light">{plural(counts.education, 'degree')}</Badge>
              <Badge variant="light">{plural(draft.skills.reduce((n, s) => n + s.items.length, 0), 'skill')}</Badge>
            </Group>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Button variant="light" loading={busy === 'import'} disabled={busy !== null} onClick={importResume}>
              Import from resume
            </Button>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button variant="default">More</Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => api.profile.openInEditor().catch((e) => setNotice({ color: 'red', text: errorText(e) }))}>
                  Open in text editor
                </Menu.Item>
                <Menu.Item onClick={() => api.profile.reveal().catch((e) => setNotice({ color: 'red', text: errorText(e) }))}>
                  Show in Finder
                </Menu.Item>
                <Menu.Item onClick={reload} disabled={busy !== null}>
                  Reload from disk
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item onClick={() => (dirty ? setConfirmLeave(true) : onSwitchWorkspace())}>
                  Switch workspace…
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <Code mt="sm" block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {doc.path}
        </Code>
      </Card>

      {notice && (
        <Alert
          color={notice.color}
          title={notice.title}
          variant="light"
          withCloseButton
          onClose={() => setNotice(null)}
          role="status"
        >
          <Stack gap="xs">
            <Text size="sm">{notice.text}</Text>
            {notice.items && notice.items.length > 0 && (
              <List size="sm">
                {notice.items.map((w) => (
                  <List.Item key={w}>{w}</List.Item>
                ))}
              </List>
            )}
            {conflict && (
              <Group>
                <Button size="xs" color="red" variant="light" onClick={reload} loading={busy === 'reload'}>
                  Reload from disk (discards edits here)
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}

      {doc.warnings.length > 0 && (
        <Alert color="yellow" variant="light" title="Some lines in the file were not recognised">
          <Spoiler maxHeight={70} showLabel="Show all" hideLabel="Hide">
            <List size="sm">
              {doc.warnings.map((w) => (
                <List.Item key={w}>{w}</List.Item>
              ))}
            </List>
          </Spoiler>
          <Text size="xs" mt="xs">
            Saving from Huntgry rewrites the file in its standard layout. Move this content into a field, or
            under its own “##” section, to keep it.
          </Text>
        </Alert>
      )}

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="contact">Contact</Tabs.Tab>
          <Tabs.Tab value="summary">Summary &amp; skills</Tabs.Tab>
          <Tabs.Tab value="experience">Experience ({counts.experience})</Tabs.Tab>
          <Tabs.Tab value="projects">Projects ({counts.projects})</Tabs.Tab>
          <Tabs.Tab value="education">Education ({counts.education})</Tabs.Tab>
          <Tabs.Tab value="credentials">Certifications &amp; publications ({counts.credentials})</Tabs.Tab>
          <Tabs.Tab value="notes">Gaps &amp; notes</Tabs.Tab>
        </Tabs.List>
        <Paper pt="md">
          <Tabs.Panel value="contact">
            <ContactSection profile={draft} onChange={setDraft} />
          </Tabs.Panel>
          <Tabs.Panel value="summary">
            <SummarySkillsSection profile={draft} onChange={setDraft} />
          </Tabs.Panel>
          <Tabs.Panel value="experience">
            <ExperienceSection profile={draft} onChange={setDraft} />
          </Tabs.Panel>
          <Tabs.Panel value="projects">
            <ProjectsSection profile={draft} onChange={setDraft} />
          </Tabs.Panel>
          <Tabs.Panel value="education">
            <EducationSection profile={draft} onChange={setDraft} />
          </Tabs.Panel>
          <Tabs.Panel value="credentials">
            <CredentialsSection profile={draft} onChange={setDraft} />
          </Tabs.Panel>
          <Tabs.Panel value="notes">
            <NotesSection profile={draft} onChange={setDraft} />
          </Tabs.Panel>
        </Paper>
      </Tabs>

      <Paper
        withBorder
        shadow="sm"
        p="sm"
        radius="md"
        style={{ position: 'sticky', bottom: 'var(--mantine-spacing-md)', zIndex: 10 }}
      >
        <Group justify="flex-end">
          <Text size="sm" c="dimmed" mr="auto">
            {dirty ? 'Unsaved changes' : `Saved in ${fileName(doc.path)}`}
          </Text>
          <Button variant="default" disabled={!dirty || busy !== null} onClick={() => setDraft(doc.profile)}>
            Discard
          </Button>
          <Button disabled={!dirty || busy !== null} loading={busy === 'save'} onClick={save}>
            Save
          </Button>
        </Group>
      </Paper>

      <Modal opened={pendingImport !== null} onClose={() => setPendingImport(null)} title="Replace the form?" centered>
        <Stack gap="sm">
          <Text size="sm">
            The form already has content. Replace it with what was parsed from{' '}
            <Code>{pendingImport?.fileName}</Code>? You can review everything before saving, and Discard brings back
            the saved profile.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPendingImport(null)}>
              Cancel
            </Button>
            <Button onClick={() => pendingImport && applyImport(pendingImport)}>Replace</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={confirmLeave} onClose={() => setConfirmLeave(false)} title="Discard unsaved changes?" centered>
        <Stack gap="sm">
          <Text size="sm">You have edits that are not saved to the master profile yet.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmLeave(false)}>
              Keep editing
            </Button>
            <Button color="red" onClick={onSwitchWorkspace}>
              Discard and switch
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Ignores differences that the file format cannot represent (blank lines in lists, trailing spaces). */
function normalize(p: MasterProfile): MasterProfile {
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean)
  return {
    ...p,
    summary: p.summary.trim(),
    gaps: clean(p.gaps),
    experience: p.experience.map((e) => ({ ...e, highlights: clean(e.highlights) })),
    projects: p.projects.map((e) => ({ ...e, highlights: clean(e.highlights) })),
    education: p.education.map((e) => ({ ...e, highlights: clean(e.highlights) }))
  }
}
