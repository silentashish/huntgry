import type { NodeKind } from '@shared/knowledge-graph'

/** Mantine palette name per node kind (graph dots, legend, badges). */
export const KIND_COLOR: Record<NodeKind, string> = {
  person: 'blue',
  experience: 'indigo',
  company: 'cyan',
  project: 'teal',
  skill: 'green',
  education: 'grape',
  certification: 'violet',
  publication: 'pink',
  job: 'yellow'
}

export const KIND_LABEL: Record<NodeKind, string> = {
  person: 'You',
  experience: 'Role',
  company: 'Company',
  project: 'Project',
  skill: 'Skill',
  education: 'Education',
  certification: 'Certification',
  publication: 'Publication',
  job: 'Job'
}
