import { ActionIcon, TextInput, Textarea } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
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
import classes from './editor.module.css'
import { AddButton, CommaListInput, EntryList, FieldGrid, LinesInput, SectionHead, type FieldSpec } from './fields'

type Edit = (next: MasterProfile) => void

const CONTACT_FIELDS: Array<FieldSpec<ContactInfo>> = [
  { key: 'name', label: 'Full name', placeholder: 'Jane Doe' },
  { key: 'headline', label: 'Headline', placeholder: 'Full-Stack Software Engineer' },
  { key: 'email', label: 'Email', placeholder: 'jane@example.com', cols: 4 },
  { key: 'phone', label: 'Phone', placeholder: '(555) 010-0100', cols: 4 },
  { key: 'location', label: 'Location', placeholder: 'City, ST', cols: 4 },
  { key: 'workAuthorization', label: 'Work authorization', placeholder: 'e.g. US citizen, needs sponsorship' },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://www.linkedin.com/in/…' },
  { key: 'github', label: 'GitHub', placeholder: 'https://github.com/…' },
  { key: 'website', label: 'Website', placeholder: 'https://…' }
]

const EXPERIENCE_FIELDS: Array<FieldSpec<ExperienceEntry>> = [
  { key: 'company', label: 'Company', cols: 4 },
  { key: 'role', label: 'Role', cols: 4 },
  { key: 'employmentType', label: 'Type', placeholder: 'Full-Time, Remote', cols: 4 },
  { key: 'start', label: 'Start', placeholder: 'Aug 2024', cols: 3 },
  { key: 'end', label: 'End', placeholder: 'Present', cols: 3 },
  { key: 'location', label: 'Location', placeholder: 'City, ST', cols: 3 },
  { key: 'projectLink', label: 'Project link', placeholder: 'https://…', cols: 3 },
  { key: 'project', label: 'Project', cols: 12 },
  { key: 'technologies', label: 'Technologies', cols: 12 },
  {
    key: 'highlights',
    label: 'Highlights',
    kind: 'lines',
    description: 'One per line. Wrap the measurable result in **double asterisks** to bold it.'
  }
]

const PROJECT_FIELDS: Array<FieldSpec<ProjectEntry>> = [
  { key: 'name', label: 'Name', cols: 4 },
  { key: 'dates', label: 'Dates', cols: 4 },
  { key: 'link', label: 'Link', placeholder: 'https://github.com/…', cols: 4 },
  { key: 'technologies', label: 'Technologies', cols: 12 },
  { key: 'description', label: 'Description', kind: 'textarea' },
  { key: 'highlights', label: 'Highlights', kind: 'lines', description: 'One per line.' }
]

const EDUCATION_FIELDS: Array<FieldSpec<EducationEntry>> = [
  { key: 'institution', label: 'Institution', cols: 4 },
  { key: 'degree', label: 'Degree', placeholder: 'Master of Science', cols: 4 },
  { key: 'field', label: 'Field of study', placeholder: 'Computer Science', cols: 4 },
  { key: 'start', label: 'Start', cols: 3 },
  { key: 'end', label: 'End', cols: 3 },
  { key: 'location', label: 'Location', cols: 3 },
  { key: 'gpa', label: 'GPA', cols: 3 },
  { key: 'highlights', label: 'Highlights', kind: 'lines', description: 'Thesis, honours, coursework… one per line.' }
]

const CERTIFICATION_FIELDS: Array<FieldSpec<CertificationEntry>> = [
  { key: 'name', label: 'Name', cols: 6 },
  { key: 'issuer', label: 'Issuer', cols: 3 },
  { key: 'date', label: 'Date', cols: 3 },
  { key: 'link', label: 'Link', cols: 12 }
]

const PUBLICATION_FIELDS: Array<FieldSpec<PublicationEntry>> = [
  { key: 'title', label: 'Title', cols: 6 },
  { key: 'venue', label: 'Venue', cols: 3 },
  { key: 'date', label: 'Date', cols: 3 },
  { key: 'link', label: 'Link', cols: 12 },
  { key: 'description', label: 'Description', kind: 'textarea' }
]

const range = (a: string, b: string) => [a, b].filter(Boolean).join(' – ')
const join = (...parts: string[]) => parts.filter(Boolean).join(' · ')
const entries = (n: number) => `${n} entr${n === 1 ? 'y' : 'ies'} · order kept in the file`

function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <ActionIcon variant="subtle" color="danger" aria-label={label} mb={6} onClick={onClick}>
      <IconTrash size={14} />
    </ActionIcon>
  )
}

export function ContactSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  const c = profile.contact
  const setContact = (contact: ContactInfo) => onChange({ ...profile, contact })
  const setOther = (i: number, patch: Partial<ContactInfo['other'][number]>) =>
    setContact({ ...c, other: c.other.map((o, j) => (j === i ? { ...o, ...patch } : o)) })
  return (
    <div className={classes.section}>
      <SectionHead title="Contact" meta="At the top of every resume" />
      <div className={classes.card}>
        <FieldGrid value={c} fields={CONTACT_FIELDS} onChange={setContact} />
      </div>
      <SectionHead
        title="Other links"
        meta="Portfolio, Stack Overflow, a talk…"
        order={4}
        action={<AddButton onClick={() => setContact({ ...c, other: [...c.other, { label: '', value: '' }] })}>Add link</AddButton>}
      />
      {c.other.length > 0 && (
        <div className={classes.card}>
          {c.other.map((o, i) => (
            <div key={i} className={classes.row}>
              <TextInput
                aria-label="Label"
                placeholder="Label (e.g. Portfolio)"
                value={o.label}
                onChange={(e) => setOther(i, { label: e.currentTarget.value })}
                w={200}
              />
              <TextInput
                aria-label="Value"
                placeholder="https://…"
                value={o.value}
                onChange={(e) => setOther(i, { value: e.currentTarget.value })}
                className={classes.grow}
              />
              <RemoveButton label="Remove link" onClick={() => setContact({ ...c, other: c.other.filter((_o, j) => j !== i) })} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SummarySkillsSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  const skills = profile.skills
  const setSkill = (i: number, patch: Partial<MasterProfile['skills'][number]>) =>
    onChange({ ...profile, skills: skills.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const count = skills.reduce((n, s) => n + s.items.length, 0)
  return (
    <div className={classes.section}>
      <SectionHead title="Summary & skills" meta="Tailored resumes pick from these" />
      <div className={classes.card}>
        <Textarea
          label="Summary"
          description="A few sentences on who you are and what you bring. Tailored resumes pick from this."
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          autosize
          minRows={4}
          value={profile.summary}
          onChange={(e) => onChange({ ...profile, summary: e.currentTarget.value })}
        />
      </div>
      <SectionHead
        title="Skills"
        meta={`${skills.length} group${skills.length === 1 ? '' : 's'} · ${count} skill${count === 1 ? '' : 's'}`}
        order={4}
        action={<AddButton onClick={() => onChange({ ...profile, skills: [...skills, { category: '', items: [] }] })}>Add skill group</AddButton>}
      />
      <div className={classes.card}>
        <p className={classes.hint}>
          Group skills by category. Separate items with commas; commas inside brackets are kept, e.g. AWS (EC2, S3).
        </p>
        {skills.map((s, i) => (
          <div key={i} className={classes.row}>
            <TextInput
              label={i === 0 ? 'Category' : undefined}
              aria-label="Category"
              placeholder="Languages"
              value={s.category}
              onChange={(e) => setSkill(i, { category: e.currentTarget.value })}
              w={220}
            />
            <div className={classes.grow}>
              <CommaListInput
                label={i === 0 ? 'Skills' : undefined}
                placeholder="Python, TypeScript, SQL"
                value={s.items}
                onChange={(items) => setSkill(i, { items })}
              />
            </div>
            <RemoveButton label="Remove skill group" onClick={() => onChange({ ...profile, skills: skills.filter((_s, j) => j !== i) })} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ExperienceSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  return (
    <EntryList
      heading="Experience"
      summary={entries(profile.experience.length)}
      items={profile.experience}
      onChange={(experience) => onChange({ ...profile, experience })}
      create={emptyExperience}
      title={(e) => join(e.role, e.company)}
      meta={(e) => range(e.start, e.end)}
      render={(e, update) => <FieldGrid value={e} fields={EXPERIENCE_FIELDS} onChange={update} />}
      addLabel="Add experience"
      empty="No experience yet. Include everything, even roles that will rarely make a resume."
    />
  )
}

export function ProjectsSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  return (
    <EntryList
      heading="Projects"
      summary={entries(profile.projects.length)}
      items={profile.projects}
      onChange={(projects) => onChange({ ...profile, projects })}
      create={emptyProject}
      title={(p) => p.name}
      meta={(p) => p.dates}
      render={(p, update) => <FieldGrid value={p} fields={PROJECT_FIELDS} onChange={update} />}
      addLabel="Add project"
      empty="No projects yet."
    />
  )
}

export function EducationSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  return (
    <EntryList
      heading="Education"
      summary={entries(profile.education.length)}
      items={profile.education}
      onChange={(education) => onChange({ ...profile, education })}
      create={emptyEducation}
      title={(e) => join([e.degree, e.field].filter(Boolean).join(', '), e.institution)}
      meta={(e) => range(e.start, e.end)}
      render={(e, update) => <FieldGrid value={e} fields={EDUCATION_FIELDS} onChange={update} />}
      addLabel="Add education"
      empty="No education yet."
    />
  )
}

export function CredentialsSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  const [certs, pubs] = [profile.certifications.length, profile.publications.length]
  return (
    <div className={classes.section}>
      <SectionHead
        title="Certifications & publications"
        meta={`${certs} certification${certs === 1 ? '' : 's'} · ${pubs} publication${pubs === 1 ? '' : 's'}`}
      />
      <EntryList
        heading="Certifications"
        headingOrder={4}
        items={profile.certifications}
        onChange={(certifications) => onChange({ ...profile, certifications })}
        create={emptyCertification}
        title={(c) => join(c.name, c.issuer)}
        meta={(c) => c.date}
        render={(c, update) => <FieldGrid value={c} fields={CERTIFICATION_FIELDS} onChange={update} />}
        addLabel="Add certification"
        empty="No certifications. Use the issuer's exact official name."
      />
      <EntryList
        heading="Publications"
        headingOrder={4}
        items={profile.publications}
        onChange={(publications) => onChange({ ...profile, publications })}
        create={emptyPublication}
        title={(p) => join(p.title, p.venue)}
        meta={(p) => p.date}
        render={(p, update) => <FieldGrid value={p} fields={PUBLICATION_FIELDS} onChange={update} />}
        addLabel="Add publication"
        empty="No publications."
      />
    </div>
  )
}

export function NotesSection({ profile, onChange }: { profile: MasterProfile; onChange: Edit }) {
  const extras = profile.extraSections
  const setExtra = (i: number, patch: Partial<MasterProfile['extraSections'][number]>) =>
    onChange({ ...profile, extraSections: extras.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  return (
    <div className={classes.section}>
      <SectionHead title="Gaps & notes" meta="What you do not have, and sections kept as you wrote them" />
      <div className={classes.card}>
        <LinesInput
          label="Gaps and constraints"
          description="What you do not have or cannot do (technologies, travel, sponsorship), one per line. Keeps the generator from papering over it."
          value={profile.gaps}
          onChange={(gaps) => onChange({ ...profile, gaps })}
        />
      </div>
      <SectionHead
        title="Other sections"
        meta="Awards, volunteering, languages… written to the file as their own “##” sections, in Markdown"
        order={4}
        action={<AddButton onClick={() => onChange({ ...profile, extraSections: [...extras, { title: '', body: '' }] })}>Add section</AddButton>}
      />
      {extras.map((x, i) => (
        <div key={i} className={classes.card}>
          <div className={classes.row}>
            <TextInput
              aria-label="Section title"
              placeholder="Section title"
              value={x.title}
              onChange={(e) => setExtra(i, { title: e.currentTarget.value })}
              className={classes.grow}
            />
            <RemoveButton label="Remove section" onClick={() => onChange({ ...profile, extraSections: extras.filter((_x, j) => j !== i) })} />
          </div>
          <Textarea
            aria-label="Section content"
            autosize
            minRows={3}
            value={x.body}
            onChange={(e) => setExtra(i, { body: e.currentTarget.value })}
          />
        </div>
      ))}
    </div>
  )
}
