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
