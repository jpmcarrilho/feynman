import { LEGACY_PROFILES } from './legacyProfiles'

const TAIL = 'analogies, common pitfalls, and formulas using the Feynman style.'

/**
 * The line under "Feynman Study Guide" in the Resources tab. The two imported studyspaces keep the wording they always had
 * (their profiles carry the legacy subjects); other studyspaces name their own subject, or get a neutral sentence. Pure.
 */
export function studyGuideBlurb(subject: string | null | undefined): string {
  const s = (subject ?? '').trim()
  if (s && Object.values(LEGACY_PROFILES).some((p) => p.subject === s)) {
    return `A structured, concept-demystifying lecture summary compiling the core intuitive economics and policy models, ${TAIL}`
  }
  return s
    ? `A structured, concept-demystifying summary of the core ${s} concepts, ${TAIL}`
    : `A structured, concept-demystifying summary compiling the core concepts, ${TAIL}`
}
