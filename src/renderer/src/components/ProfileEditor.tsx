import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Alert, Button, Center, Code, Group, List, Menu, SegmentedControl, Spoiler, Stack, Tabs, Text } from '@mantine/core'
import {
  IconChartDots3,
  IconCheck,
  IconChevronDown,
  IconFileImport,
  IconFileText,
  IconListCheck,
  IconPencil,
  IconUpload
} from '@tabler/icons-react'
import { isProfileEmpty, type MasterProfile, type ProfileDocument } from '@shared/master-profile'
import { api, errorText } from '../api'
import type { ProfileSection, ProfileView } from '../navigation'
import { ConfirmModal } from './profile/ConfirmModal'
import { fieldsLabel, profileChanges } from './profile/changes'
import classes from './profile/editor.module.css'
import {
  ContactSection,
  CredentialsSection,
  EducationSection,
  ExperienceSection,
  NotesSection,
  ProjectsSection,
  SummarySkillsSection
} from './profile/sections'
import { CompanyAvatar, MonoLabel, StatusPill } from './ui'

type Notice = { color: 'green' | 'red' | 'yellow' | 'blue'; title?: string; text: string; items?: string[] } | null

const VIEWS: Array<{ value: ProfileView; label: string; icon: typeof IconPencil }> = [
  { value: 'editor', label: 'Editor', icon: IconPencil },
  { value: 'graph', label: 'Knowledge graph', icon: IconChartDots3 },
  { value: 'skills', label: 'Skills', icon: IconListCheck }
]

interface Props {
  document: ProfileDocument
  /** A draft to start from instead of the file content, e.g. a parsed resume. */
  initialDraft?: { profile: MasterProfile; fileName: string; warnings: string[] }
  onDocumentChange(doc: ProfileDocument): void
  onSwitchWorkspace(): void
  /** Called whenever the number of fields that differ from the file changes (0: nothing unsaved). */
  onUnsavedChange?(fields: number): void
  /** Section to open, e.g. when another page deep-links into one; applied again whenever `sectionRequest` changes. */
  section?: ProfileSection
  /** Changes on every navigation (the location's params), so the same section can be requested twice. */
  sectionRequest?: unknown
  /** Which view of the Profile page is shown; the header, notices and save bar are common to all. */
  view?: ProfileView
  onViewChange?(view: ProfileView): void
  /** The Knowledge graph or Skills view, shown instead of the form when `view` is not `editor`. */
  children?: ReactNode
}

/**
 * The master profile: header, view switcher and the form. Edits stay in memory
 * until Save, which rewrites the Markdown file; the file is re-read afterwards
 * so the form always shows exactly what is on disk. The draft lives here, so
 * switching to the graph or the skills and back keeps it.
 */
export function ProfileEditor({
  document: doc,
  initialDraft,
  onDocumentChange,
  onSwitchWorkspace,
  onUnsavedChange,
  section,
  sectionRequest,
  view = 'editor',
  onViewChange,
  children
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
  const [tab, setTab] = useState<string | null>(section ?? 'contact')

  useEffect(() => {
    if (section) setTab(section)
  }, [sectionRequest])

  const changes = useMemo(() => profileChanges(draft, doc.profile), [draft, doc])
  const dirty = changes > 0
  const file = fileName(doc.path)

  useEffect(() => {
    onUnsavedChange?.(changes)
  }, [changes, onUnsavedChange])

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
    // The import is reviewed in the form.
    if (view !== 'editor') onViewChange?.('editor')
    setNotice({
      color: 'blue',
      title: `Imported from ${result.fileName}`,
      text: 'Review every section, then save. Nothing is written to master-profile.md until you do.',
      items: result.warnings
    })
  }

  const c = draft.contact
  const gaps = draft.gaps.filter((g) => g.trim()).length
  const counts = {
    experience: draft.experience.length,
    projects: draft.projects.length,
    education: draft.education.length,
    credentials: draft.certifications.length + draft.publications.length,
    skills: draft.skills.reduce((n, s) => n + s.items.length, 0)
  }
  const name = c.name.trim()

  const sectionTab = (value: string, label: string, count?: number, tone?: 'warning') => (
    <Tabs.Tab
      value={value}
      // "Experience (2)": the count is part of the name, as before the redesign; the gaps flag is not.
      aria-label={count === undefined || tone ? label : `${label} (${count})`}
      rightSection={
        count !== undefined && (count > 0 || tone === undefined) ? (
          <span className={classes.count} data-tone={tone} aria-hidden>
            {count}
          </span>
        ) : undefined
      }
    >
      {label}
    </Tabs.Tab>
  )

  return (
    <Stack gap="lg">
      <section className={classes.headerCard} aria-label="Master profile">
        <CompanyAvatar name={name || '?'} shape="circle" size="lg" tone="accent" />
        <div className={classes.headerText}>
          <div className={classes.nameRow}>
            <h3 className={classes.name}>{name || 'Your master profile'}</h3>
            <span className={classes.fileBadge} title={doc.path}>
              <IconFileText size={12} aria-hidden />
              <span>{file}</span>
            </span>
          </div>
          <p className={classes.contactLine}>
            {[c.headline, c.location, c.email, c.phone].filter((v) => v.trim()).join(' · ') || 'Fill in your details below.'}
          </p>
          <div className={classes.pills}>
            <StatusPill>{plural(counts.experience, 'role')}</StatusPill>
            <StatusPill>{plural(counts.projects, 'project')}</StatusPill>
            <StatusPill>{plural(counts.education, 'degree')}</StatusPill>
            <StatusPill tone="trail">{plural(counts.skills, 'skill')}</StatusPill>
            {gaps > 0 && <StatusPill tone="warning">{plural(gaps, 'gap')}</StatusPill>}
          </div>
        </div>
        <div className={classes.headerActions}>
          <Button
            variant="default"
            leftSection={<IconUpload size={16} />}
            loading={busy === 'import'}
            disabled={busy !== null}
            onClick={importResume}
          >
            Import from resume
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button variant="subtle" rightSection={<IconChevronDown size={16} />}>
                More
              </Button>
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
              <Menu.Item onClick={() => (dirty ? setConfirmLeave(true) : onSwitchWorkspace())}>Switch workspace…</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </section>

      <Group justify="space-between" gap="sm" wrap="wrap">
        <SegmentedControl
          aria-label="Profile view"
          value={view}
          onChange={(v) => onViewChange?.(v as ProfileView)}
          data={VIEWS.map(({ value, label, icon: Icon }) => ({
            value,
            label: (
              <Center inline style={{ gap: 6 }}>
                <Icon size={14} aria-hidden />
                <span>{label}</span>
              </Center>
            )
          }))}
        />
        <MonoLabel size="xs" tone="muted" title={doc.path}>
          {dirty ? <span>{file} on disk is unchanged until you save</span> : <span>Saved in {file}</span>}
          {' · '}the file is the only store, edit it anywhere
        </MonoLabel>
      </Group>

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

      {view === 'editor' ? (
        <Tabs
          value={tab}
          onChange={setTab}
          keepMounted={false}
          orientation="vertical"
          variant="pills"
          classNames={{ root: classes.tabs, list: classes.tabList, tab: classes.tab, tabLabel: classes.tabLabel, panel: classes.panel }}
        >
          <Tabs.List aria-label="Sections">
            {sectionTab('contact', 'Contact')}
            {sectionTab('summary', 'Summary & skills')}
            {sectionTab('experience', 'Experience', counts.experience)}
            {sectionTab('projects', 'Projects', counts.projects)}
            {sectionTab('education', 'Education', counts.education)}
            {sectionTab('credentials', 'Certifications & publications', counts.credentials)}
            {sectionTab('notes', 'Gaps & notes', gaps, 'warning')}
          </Tabs.List>
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
        </Tabs>
      ) : (
        children
      )}

      {dirty && (
        <div className={classes.saveDock}>
          <div className={classes.saveBar} role="region" aria-label="Unsaved changes">
            <span className={classes.saveDot} aria-hidden />
            <span className={classes.saveText}>Unsaved changes · {fieldsLabel(changes)}</span>
            <Button size="xs" variant="subtle" disabled={busy !== null} onClick={() => setDraft(doc.profile)}>
              Discard
            </Button>
            <Button
              size="xs"
              variant="primary"
              leftSection={<IconCheck size={14} />}
              disabled={busy !== null}
              loading={busy === 'save'}
              onClick={save}
            >
              Save to {file}
            </Button>
          </div>
        </div>
      )}

      <ConfirmModal
        opened={pendingImport !== null}
        title="Replace the form?"
        tone="info"
        icon={<IconFileImport size={18} />}
        confirmLabel="Replace"
        confirmKind="primary"
        onCancel={() => setPendingImport(null)}
        onConfirm={() => pendingImport && applyImport(pendingImport)}
      >
        The form already has content. Replace it with what was parsed from <Code>{pendingImport?.fileName}</Code>? You can
        review everything before saving, and Discard brings back the saved profile.
      </ConfirmModal>

      <ConfirmModal
        opened={confirmLeave}
        title="Discard unsaved changes?"
        cancelLabel="Keep editing"
        confirmLabel="Discard and switch"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={onSwitchWorkspace}
      >
        The master profile has {fieldsLabel(changes)} unsaved. Switching workspace throws them away; {file} on disk is not
        touched.
      </ConfirmModal>
    </Stack>
  )
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
