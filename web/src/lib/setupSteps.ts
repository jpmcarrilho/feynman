// Steps of the studyspace setup wizard. Pure and client-safe.

export const SETUP_STEPS = ['upload', 'processing', 'outline', 'persona'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  upload: 'Upload files',
  processing: 'Processing',
  outline: 'Review outline',
  persona: 'Tutor',
}

export type SetupState = {
  /** Files of the first setup (bundle initial). */
  sourceCount: number
  /** At least one initial file, and every initial file is ready or failed. */
  initialFinished: boolean
  /** Initial files that are ready. */
  readyInitialCount: number
  /** The studyspace has an accepted tutor profile: the tutor step is where it is changed. */
  hasProfile?: boolean
}

export function isSetupStep(v: unknown): v is SetupStep {
  return typeof v === 'string' && (SETUP_STEPS as readonly string[]).includes(v)
}

/**
 * The step to show: the requested one when the real state allows it, else the step the state calls for.
 *  - no files: always 'upload';
 *  - files still being processed: 'processing' (more files can be added there);
 *  - all initial files finished with at least one ready: 'outline' (also the default), 'processing' stays reachable;
 *  - all finished and none ready: 'processing' (retry, remove or add files);
 *  - 'persona' when requested in that state, and also by default when the studyspace already has an accepted tutor.
 */
export function resolveSetupStep(requested: string | null | undefined, state: SetupState): SetupStep {
  if (state.sourceCount === 0) return 'upload'
  if (!state.initialFinished) return 'processing'
  if (state.readyInitialCount === 0) return 'processing'
  if (requested === 'processing') return 'processing'
  if (requested === 'persona') return 'persona'
  if (state.hasProfile && requested !== 'outline') return 'persona'
  return 'outline'
}
