import { defaultProfile, parseProfile, type TutorProfile } from './profile'
import { LEGACY_PROFILES } from './legacyProfiles'

/**
 * Profile of a course row: the stored profile, else the legacy profile for the two MIT course codes
 * (covers a database that was not backfilled), else a neutral default. Pure, safe for client code.
 */
export function resolveProfile(course: { code: string; title: string; profile?: string | null; goal?: string | null }): TutorProfile {
  return parseProfile(course.profile) ?? LEGACY_PROFILES[course.code] ?? defaultProfile({ title: course.title, goal: course.goal })
}
