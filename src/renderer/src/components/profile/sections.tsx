import { ActionIcon, Button, Group, Stack, Text, TextInput, Textarea, Title } from '@mantine/core'
import {
  emptyCertification,
  emptyEducation,
  emptyExperience,
  emptyProject,
  emptyPublication,
  type CertificationEntry,
  type ContactInfo,
  type EducationEntry,
  type ExperienceEntry,
  type MasterProfile,
  type ProjectEntry,
  type PublicationEntry
} from '@shared/master-profile'
import { CommaListInput, EntryList, FieldGrid, LinesInput, type FieldSpec } from './fields'

type Edit = (next: MasterProfile) => void

const CONTACT_FIELDS: Array<FieldSpec<ContactInfo>> = [
  { key: 'name', label: 'Full name', placeholder: 'Jane Doe' },
  { key: 'headline', label: 'Headline', placeholder: 'Full-Stack Software Engineer' },
  { key: 'email', label: 'Email', placeholder: 'jane@example.com' },
  { key: 'phone', label: 'Phone', placeholder: '(555) 010-0100' },
  { key: 'location', label: 'Location', placeholder: 'City, ST' },
  { key: 'workAuthorization', label: 'Work authorization', placeholder: 'e.g. US citizen, needs sponsorship' },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://www.linkedin.com/in/…' },
  { key: 'github', label: 'GitHub', placeholder: 'https://github.com/…' },
  { key: 'website', label: 'Website', placeholder: 'https://…', span: 2 }
]

const EXPERIENCE_FIELDS: Array<FieldSpec<ExperienceEntry>> = [
  { key: 'company', label: 'Company' },
  { key: 'role', label: 'Role' },
  { key: 'start', label: 'Start', placeholder: 'Aug 2024' },
  { key: 'end', label: 'End', placeholder: 'Present' },
  { key: 'location', label: 'Location', placeholder: 'City, ST' },
  { key: 'employmentType', label: 'Type', placeholder: 'Full-Time, Remote' },
  { key: 'project', label: 'Project' },
  { key: 'projectLink', label: 'Project link', placeholder: 'https://…' },
  { key: 'technologies', label: 'Technologies', span: 2 },
  {
    key: 'highlights',
    label: 'Highlights',
    kind: 'lines',
    description: 'One per line. Wrap the measurable result in **double asterisks** to bold it.'
  }
]

const PROJECT_FIELDS: Array<FieldSpec<ProjectEntry>> = [
  { key: 'name', label: 'Name' },
  { key: 'link', label: 'Link', placeholder: 'https://github.com/…' },
  { key: 'dates', label: 'Dates' },
  { key: 'technologies', label: 'Technologies' },
  { key: 'description', label: 'Description', kind: 'textarea' },
  { key: 'highlights', label: 'Highlights', kind: 'lines', description: 'One per line.' }
]

const EDUCATION_FIELDS: Array<FieldSpec<EducationEntry>> = [
  { key: 'institution', label: 'Institution', span: 2 },
  { key: 'degree', label: 'Degree', placeholder: 'Master of Science' },
  { key: 'field', label: 'Field of study', placeholder: 'Computer Science' },
  { key: 'start', label: 'Start' },
  { key: 'end', label: 'End' },
  { key: 'location', label: 'Location' },
  { key: 'gpa', label: 'GPA' },
  { key: 'highlights', label: 'Highlights', kind: 'lines', description: 'Thesis, honours, coursework… one per line.' }
]

const CERTIFICATION_FIELDS: Array<FieldSpec<CertificationEntry>> = [
  { key: 'name', label: 'Name', span: 2 },
  { key: 'issuer', label: 'Issuer' },
  { key: 'date', label: 'Date' },
  { key: 'link', label: 'Link', span: 2 }
]

const PUBLICATION_FIELDS: Array<FieldSpec<PublicationEntry>> = [
  { key: 'title', label: 'Title', span: 2 },
  { key: 'venue', label: 'Venue' },
  { key: 'date', label: 'Date' },
  { key: 'link', label: 'Link', span: 2 },
  { key: 'description', label: 'Description', kind: 'textarea' }
]

const range = (a: string, b: string) => [a, b].filter(Boolean).join(' – ')
const join = (...parts: string[]) => parts.filter(Boolean).join(' · ')

export function ContactSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  const c = profile.contact
  const setContact = (contact: ContactInfo) => onChange({ ...profile, contact })
  const setOther = (i: number, patch: Partial<ContactInfo['other'][number]>) =>
    setContact({ ...c, other: c.other.map((o, j) => (j === i ? { ...o, ...patch } : o)) })
  return (
    <Stack gap="md">
      <FieldGrid value={c} fields={CONTACT_FIELDS} onChange={setContact} />
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          Other links
        </Text>
        {c.other.map((o, i) => (
          <Group key={i} wrap="nowrap" align="flex-end">
            <TextInput
              aria-label="Label"
              placeholder="Label (e.g. Portfolio)"
              value={o.label}
              onChange={(e) => setOther(i, { label: e.currentTarget.value })}
              w={180}
            />
            <TextInput
              aria-label="Value"
              placeholder="https://…"
              value={o.value}
              onChange={(e) => setOther(i, { value: e.currentTarget.value })}
              style={{ flex: 1 }}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label="Remove link"
              mb={4}
              onClick={() => setContact({ ...c, other: c.other.filter((_o, j) => j !== i) })}
            >
              ✕
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button variant="light" size="xs" onClick={() => setContact({ ...c, other: [...c.other, { label: '', value: '' }] })}>
            Add link
          </Button>
        </Group>
      </Stack>
    </Stack>
  )
}

export function SummarySkillsSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  const skills = profile.skills
  const setSkill = (i: number, patch: Partial<MasterProfile['skills'][number]>) =>
    onChange({ ...profile, skills: skills.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  return (
    <Stack gap="lg">
      <Textarea
        label="Summary"
        description="A few sentences on who you are and what you bring. Tailored resumes pick from this."
        autosize
        minRows={4}
        value={profile.summary}
        onChange={(e) => onChange({ ...profile, summary: e.currentTarget.value })}
      />
      <Stack gap="xs">
        <Title order={5}>Skills</Title>
        <Text size="xs" c="dimmed">
          Group skills by category. Separate items with commas; commas inside brackets are kept, e.g. AWS (EC2, S3).
        </Text>
        {skills.map((s, i) => (
          <Group key={i} wrap="nowrap" align="flex-end">
            <TextInput
              label={i === 0 ? 'Category' : undefined}
              aria-label="Category"
              placeholder="Languages"
              value={s.category}
              onChange={(e) => setSkill(i, { category: e.currentTarget.value })}
              w={220}
            />
            <div style={{ flex: 1 }}>
              <CommaListInput
                label={i === 0 ? 'Skills' : undefined}
                placeholder="Python, TypeScript, SQL"
                value={s.items}
                onChange={(items) => setSkill(i, { items })}
              />
            </div>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label="Remove skill group"
              mb={4}
              onClick={() => onChange({ ...profile, skills: skills.filter((_s, j) => j !== i) })}
            >
              ✕
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button
            variant="light"
            size="xs"
            onClick={() => onChange({ ...profile, skills: [...skills, { category: '', items: [] }] })}
          >
            Add skill group
          </Button>
        </Group>
      </Stack>
    </Stack>
  )
}

export function ExperienceSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  return (
    <EntryList
      items={profile.experience}
      onChange={(experience) => onChange({ ...profile, experience })}
      create={emptyExperience}
      title={(e) => join(e.role, e.company, range(e.start, e.end))}
      render={(e, update) => <FieldGrid value={e} fields={EXPERIENCE_FIELDS} onChange={update} />}
      addLabel="Add experience"
      empty="No experience yet. Include everything, even roles that will rarely make a resume."
    />
  )
}

export function ProjectsSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  return (
    <EntryList
      items={profile.projects}
      onChange={(projects) => onChange({ ...profile, projects })}
      create={emptyProject}
      title={(p) => join(p.name, p.dates)}
      render={(p, update) => <FieldGrid value={p} fields={PROJECT_FIELDS} onChange={update} />}
      addLabel="Add project"
      empty="No projects yet."
    />
  )
}

export function EducationSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  return (
    <EntryList
      items={profile.education}
      onChange={(education) => onChange({ ...profile, education })}
      create={emptyEducation}
      title={(e) => join([e.degree, e.field].filter(Boolean).join(', '), e.institution, range(e.start, e.end))}
      render={(e, update) => <FieldGrid value={e} fields={EDUCATION_FIELDS} onChange={update} />}
      addLabel="Add education"
      empty="No education yet."
    />
  )
}

export function CredentialsSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={5}>Certifications</Title>
        <EntryList
          items={profile.certifications}
          onChange={(certifications) => onChange({ ...profile, certifications })}
          create={emptyCertification}
          title={(c) => join(c.name, c.issuer, c.date)}
          render={(c, update) => <FieldGrid value={c} fields={CERTIFICATION_FIELDS} onChange={update} />}
          addLabel="Add certification"
          empty="No certifications. Use the issuer's exact official name."
        />
      </Stack>
      <Stack gap="xs">
        <Title order={5}>Publications</Title>
        <EntryList
          items={profile.publications}
          onChange={(publications) => onChange({ ...profile, publications })}
          create={emptyPublication}
          title={(p) => join(p.title, p.venue, p.date)}
          render={(p, update) => <FieldGrid value={p} fields={PUBLICATION_FIELDS} onChange={update} />}
          addLabel="Add publication"
          empty="No publications."
        />
      </Stack>
    </Stack>
  )
}

export function NotesSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  const extras = profile.extraSections
  const setExtra = (i: number, patch: Partial<MasterProfile['extraSections'][number]>) =>
    onChange({ ...profile, extraSections: extras.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  return (
    <Stack gap="lg">
      <LinesInput
        label="Gaps and constraints"
        description="What you do not have or cannot do (technologies, travel, sponsorship), one per line. Keeps the generator from papering over it."
        value={profile.gaps}
        onChange={(gaps) => onChange({ ...profile, gaps })}
      />
      <Stack gap="xs">
        <Title order={5}>Other sections</Title>
        <Text size="xs" c="dimmed">
          Awards, volunteering, languages… Written to the file as their own “##” sections, in Markdown.
        </Text>
        {extras.map((x, i) => (
          <Stack key={i} gap={4}>
            <Group wrap="nowrap" align="flex-end">
              <TextInput
                aria-label="Section title"
                placeholder="Section title"
                value={x.title}
                onChange={(e) => setExtra(i, { title: e.currentTarget.value })}
                style={{ flex: 1 }}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Remove section"
                mb={4}
                onClick={() => onChange({ ...profile, extraSections: extras.filter((_x, j) => j !== i) })}
              >
                ✕
              </ActionIcon>
            </Group>
            <Textarea
              aria-label="Section content"
              autosize
              minRows={3}
              value={x.body}
              onChange={(e) => setExtra(i, { body: e.currentTarget.value })}
            />
          </Stack>
        ))}
        <Group>
          <Button
            variant="light"
            size="xs"
            onClick={() => onChange({ ...profile, extraSections: [...extras, { title: '', body: '' }] })}
          >
            Add section
          </Button>
        </Group>
      </Stack>
    </Stack>
  )
}
