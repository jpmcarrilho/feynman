// The runner hook that checks, after a file added later is ready, whether the tutor should change (T26). Registered once at server
// start from src/instrumentation.ts. It never changes the tutor: it only stores a suggestion that the owner accepts or ignores.
import { onSourceTerminal } from './runner'
import { suggestProfileUpdate, type ProposalDeps } from './profileProposal'
import { beginUpdateCheck, endUpdateCheck } from './updateCheckState'

export const PROFILE_UPDATE_HOOK = 'profileUpdate'

/** One check at a time per studyspace, in the order the files finished, so a newer file's suggestion replaces an older one. */
const chains = new Map<string, Promise<void>>()

/**
 * Registers the hook under the name `profileUpdate` (a second registration replaces the first, so a hot reload never stacks them).
 * The model call runs in the background and is not awaited by the runner, so a slow or failing call never delays the next file.
 * Returns the function that removes the hook, and, for tests, `whenSettled`.
 */
export function registerProfileUpdateHook(deps: ProposalDeps = {}): { unregister: () => void; whenSettled: () => Promise<void> } {
  const unregister = onSourceTerminal(PROFILE_UPDATE_HOOK, async ({ courseId, sourceId, status }) => {
    if (status !== 'ready') return
    const previous = chains.get(courseId) ?? Promise.resolve()
    beginUpdateCheck(courseId) // visible to the status poll until the check has settled
    const next = previous
      .then(async () => { await suggestProfileUpdate(courseId, sourceId, deps) })
      .catch((error) => console.warn('[persona] tutor update check failed:', error instanceof Error ? error.message.slice(0, 200) : error))
      .finally(() => {
        endUpdateCheck(courseId)
        if (chains.get(courseId) === next) chains.delete(courseId)
      })
    chains.set(courseId, next)
  })
  return { unregister, whenSettled: async () => { while (chains.size > 0) await Promise.all([...chains.values()]) } }
}
