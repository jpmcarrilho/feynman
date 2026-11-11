// Server side of the persona step (T25): reading what the card needs, accepting the profile, dismissing a suggestion.
// Refusals come back as { ok: false, reason } because the message of an error thrown from a server action is masked in production.
import { prisma } from '@/lib/db'
import { TutorProfileSchema, parseProfile, type ProfileSuggestion, type TutorProfile } from '@/lib/studyspace/profile'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'
import { getSpaceStatus } from '@/services/spaceStatus'
import { isImportedStudyspace } from '@/services/outlineService'
import { ensureInitialProposal, excludedFrom, parseSuggestion, type ProposalDeps } from './profileProposal'

export type PersonaFailure = { ok: false; reason: string }

export const IMPORTED_TUTOR_REASON = 'The tutor settings of this studyspace cannot be changed here.'

export type PersonaModule = { name: string; title: string }

export type PersonaStep = {
  ok: true
  /** 'proposal': a stored proposal to review before the first accept. 'accepted': the accepted profile, for editing later. */
  mode: 'proposal' | 'accepted'
  profile: TutorProfile
  rationale: string | null
  excludedSources: ProfileSuggestion['excludedSources']
  split: { groups: { label: string; sources: { id: string; name: string }[] }[] } | null
  /** Modules of the outline, for the difficulty-calibration select. */
  modules: PersonaModule[]
  /** The studyspace came from the two imported courses: the card is shown but cannot be saved. */
  readOnly: boolean
  starterStatus: string | null
  starterProgress: { topicsWithQuestions: number; studyTopics: number }
}

async function moduleList(courseId: string): Promise<PersonaModule[]> {
  const rows = await prisma.topic.findMany({ where: { courseId }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { week: true } })
  const seen = new Set<string>()
  const out: PersonaModule[] = []
  for (const r of rows) {
    const name = r.week ?? ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, title: name.replace(/^\d+\s·\s/, '') })
  }
  return out
}

/** A calibration label that names no module of the studyspace counts as none. Pure. */
export function validCalibration(label: string | null, modules: PersonaModule[]): string | null {
  return label && modules.some((m) => m.name === label) ? label : null
}

type StepCommon = Pick<PersonaStep, 'modules' | 'readOnly' | 'starterStatus' | 'starterProgress'>

async function stepFromSuggestion(s: ProfileSuggestion, common: StepCommon): Promise<PersonaStep> {
  let split: PersonaStep['split'] = null
  if (s.split) {
    const ids = s.split.groups.flatMap((g) => g.sourceIds)
    const names = new Map((await prisma.source.findMany({ where: { id: { in: ids } }, select: { id: true, originalName: true } })).map((r) => [r.id, r.originalName]))
    split = { groups: s.split.groups.map((g) => ({ label: g.label, sources: g.sourceIds.map((id) => ({ id, name: names.get(id) ?? 'File' })) })) }
  }
  return {
    ok: true, mode: 'proposal', profile: { ...s.profile, calibrationModule: validCalibration(s.profile.calibrationModule, common.modules) },
    rationale: s.rationale, excludedSources: s.excludedSources, split, ...common,
  }
}

async function loadCommon(courseId: string) {
  const course = await prisma.course.findUnique({ where: { id: courseId } })
  if (!course) return null
  const [modules, status, imported] = await Promise.all([moduleList(courseId), getSpaceStatus(courseId), isImportedStudyspace(courseId)])
  const common: StepCommon = {
    modules,
    readOnly: imported,
    starterStatus: course.starterStatus,
    starterProgress: status?.starterProgress ?? { topicsWithQuestions: 0, studyTopics: 0 },
  }
  const accepted = parseProfile(course.profile)
  const acceptedStep: PersonaStep | null =
    accepted || imported
      ? (() => {
          const profile = resolveProfile(course)
          return { ok: true, mode: 'accepted', profile: { ...profile, calibrationModule: validCalibration(profile.calibrationModule, modules) }, rationale: null, excludedSources: [], split: null, ...common }
        })()
      : null
  return { course, common, acceptedStep }
}

/**
 * What the persona step shows. A studyspace without an accepted profile gets its initial proposal (made now when none matches the
 * current ready files, see ensureInitialProposal); one with a profile gets that profile for editing.
 */
export async function getPersonaStep(courseId: string, deps: ProposalDeps = {}, opts: { force?: boolean } = {}): Promise<PersonaStep | PersonaFailure> {
  const loaded = await loadCommon(courseId)
  if (!loaded) return { ok: false, reason: 'Studyspace not found.' }
  if (loaded.acceptedStep) return loaded.acceptedStep
  const result = await ensureInitialProposal(courseId, deps, opts)
  if (!result.ok) {
    if (result.code === 'has_profile') return getPersonaStep(courseId, deps)
    return { ok: false, reason: result.reason }
  }
  return stepFromSuggestion(result.suggestion, loaded.common)
}

/**
 * Only what is already stored, never a model call: the accepted profile, or a stored initial proposal that still matches the ready
 * files (all initial files finished). null when a proposal would have to be made. Used to render the persona step at once.
 */
export async function readStoredPersonaStep(courseId: string): Promise<PersonaStep | null> {
  const loaded = await loadCommon(courseId)
  if (!loaded) return null
  if (loaded.acceptedStep) return loaded.acceptedStep
  const stored = parseSuggestion(loaded.course.profileSuggestion)
  if (!stored || stored.kind !== 'initial') return null
  const sources = await prisma.source.findMany({ where: { courseId, bundle: 'initial' }, select: { id: true, originalName: true, status: true, error: true } })
  if (sources.some((s) => s.status !== 'ready' && s.status !== 'failed')) return null
  const ready = sources.filter((s) => s.status === 'ready').map((s) => s.id)
  if (ready.length !== stored.basedOnSourceIds.length || !ready.every((id) => stored.basedOnSourceIds.includes(id))) return null
  return stepFromSuggestion({ ...stored, excludedSources: excludedFrom(sources) }, loaded.common)
}

export type AcceptResult = { ok: true; starters: 'requested' | 'not_needed' } | PersonaFailure

/**
 * Validates `input` with TutorProfileSchema (the client object is never trusted), writes Course.profile and clears the suggestion,
 * then asks for the starter questions once: requestStarters moves waiting_for_profile/failed to pending and queues the job; a
 * studyspace whose starters are pending, running or done is left alone, so editing an accepted profile later starts nothing, unless the
 * last run failed. A studyspace whose status is still null but has a ready file is moved to waiting_for_profile first.
 */
export async function acceptProfile(
  courseId: string,
  input: unknown,
  deps: { requestStarters: (courseId: string) => Promise<boolean> },
): Promise<AcceptResult> {
  const parsed = TutorProfileSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, reason: `The tutor settings are not valid${issue ? ` (${issue.path.join('.') || 'profile'}: ${issue.message})` : ''}. Check the fields and try again.` }
  }
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true } })
  if (!course) return { ok: false, reason: 'Studyspace not found.' }
  if (await isImportedStudyspace(courseId)) return { ok: false, reason: IMPORTED_TUTOR_REASON }
  const modules = await moduleList(courseId)
  const profile: TutorProfile = { ...parsed.data, calibrationModule: validCalibration(parsed.data.calibrationModule, modules) }
  await prisma.course.update({ where: { id: courseId }, data: { profile: JSON.stringify(profile), profileSuggestion: null } })
  if ((await prisma.source.count({ where: { courseId, status: 'ready' } })) > 0) {
    await prisma.course.updateMany({ where: { id: courseId, starterStatus: null }, data: { starterStatus: 'waiting_for_profile' } })
  }
  const requested = await deps.requestStarters(courseId)
  return { ok: true, starters: requested ? 'requested' : 'not_needed' }
}

/** Drops the stored suggestion (Ignore on an update, or discarding a proposal). The accepted profile is never touched. */
export async function dismissSuggestion(courseId: string): Promise<{ ok: true } | PersonaFailure> {
  const done = await prisma.course.updateMany({ where: { id: courseId }, data: { profileSuggestion: null } })
  return done.count === 1 ? { ok: true } : { ok: false, reason: 'Studyspace not found.' }
}

/** "Keep together": the stored proposal stays, only its split offer goes. */
export async function dismissSplitNotice(courseId: string): Promise<{ ok: true } | PersonaFailure> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { profileSuggestion: true } })
  if (!course) return { ok: false, reason: 'Studyspace not found.' }
  const s = parseSuggestion(course.profileSuggestion)
  if (s?.split) await prisma.course.update({ where: { id: courseId }, data: { profileSuggestion: JSON.stringify({ ...s, split: null }) } })
  return { ok: true }
}
