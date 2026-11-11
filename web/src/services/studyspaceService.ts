import { prisma } from '@/lib/db'
import { defaultProfile, type TutorProfile } from '@/lib/studyspace/profile'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'

export type CourseWithProfile = { id: string; code: string; title: string; profile: TutorProfile }

/** Course identity plus its tutor profile (stored, legacy by code, or default). null when the course does not exist. */
export async function getCourseWithProfile(courseId: string): Promise<CourseWithProfile | null> {
  const course = await prisma.course.findUnique({ where: { id: courseId } })
  if (!course) return null
  return { id: course.id, code: course.code, title: course.title, profile: resolveProfile(course) }
}

/** Profile for a course; a neutral default when the course is unknown. */
export async function getProfileForCourse(courseId: string): Promise<TutorProfile> {
  const course = await getCourseWithProfile(courseId)
  return course?.profile ?? defaultProfile({ title: 'General study' })
}

/** Profile of the course a topic belongs to; a neutral default when the topic is unknown. */
export async function getProfileForTopic(topicId: string): Promise<TutorProfile> {
  const topic = await prisma.topic.findUnique({ where: { id: topicId }, select: { courseId: true } })
  if (!topic) return defaultProfile({ title: 'General study' })
  return getProfileForCourse(topic.courseId)
}

/**
 * Persona for actions that are not scoped to one course yet (global diagnosis, planner, plan catalog).
 * One known course: its profile and code. Otherwise the legacy global persona. Replaced by real scoping in T16.
 */
export async function getProfileForCourses(
  courseIds: string[],
): Promise<{ profile: TutorProfile; courses: { id: string; code: string; title: string; calibrationModule: string | null }[] }> {
  const unique = [...new Set(courseIds)]
  const loaded = (await Promise.all(unique.map((id) => getCourseWithProfile(id)))).filter((c): c is CourseWithProfile => !!c)
  const courses = loaded.map(({ id, code, title, profile }) => ({ id, code, title, calibrationModule: profile.calibrationModule }))
  return { profile: loaded.length === 1 ? loaded[0].profile : LEGACY_VOICE_PROFILE, courses }
}

// --- Creating a studyspace (T23) -------------------------------------------------------------------------------------

export const MAX_SPACE_NAME_LENGTH = 80
export const MAX_SPACE_GOAL_LENGTH = 300

/** Lower-case ASCII slug of a name for `Course.code` ("Organic Chem II" -> "organic-chem-ii"); "space" when nothing is left. Pure. */
export function slugifyName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'space'
}

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** `Course.code` of a new space: the slug of its name plus 6 random characters (plan 3.1), e.g. "organic-chem-a1b2c3". */
export function makeSpaceCode(name: string, random: () => number = Math.random): string {
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]
  return `${slugifyName(name)}-${suffix}`
}

export type CreateSpaceResult = { ok: true; id: string } | { ok: false; reason: string }

/** Validates and creates an empty studyspace. The code is unique; a collision (1 in 2 billion) retries with a new suffix. */
export async function createStudyspace(input: { name: unknown; goal?: unknown }): Promise<CreateSpaceResult> {
  const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  if (!name) return { ok: false, reason: 'A studyspace needs a name.' }
  if (name.length > MAX_SPACE_NAME_LENGTH) return { ok: false, reason: `The name can have at most ${MAX_SPACE_NAME_LENGTH} characters.` }
  const goalRaw = typeof input?.goal === 'string' ? input.goal.trim() : ''
  if (goalRaw.length > MAX_SPACE_GOAL_LENGTH) return { ok: false, reason: `The goal can have at most ${MAX_SPACE_GOAL_LENGTH} characters.` }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const course = await prisma.course.create({
        data: { code: makeSpaceCode(name), title: name, goal: goalRaw || null },
        select: { id: true },
      })
      return { ok: true, id: course.id }
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') continue
      throw error
    }
  }
  return { ok: false, reason: 'Could not create the studyspace. Try again.' }
}
