// Steps of the studyspace setup wizard. Pure and client-safe. T25 adds the persona step after 'outline': add it to
// SETUP_STEPS and to resolveSetupStep, nothing else here changes.

export const SETUP_STEPS = ['upload', 'processing', 'outline'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  upload: 'Upload files',
  processing: 'Processing',
  outline: 'Review outline',
}

export type SetupState = {
  /** Files of the first setup (bundle initial). */
  sourceCount: number
  /** At least one initial file, and every initial file is ready or failed. */
  initialFinished: boolean
  /** Initial files that are ready. */
  readyInitialCount: number
}

export function isSetupStep(v: unknown): v is SetupStep {
  return typeof v === 'string' && (SETUP_STEPS as readonly string[]).includes(v)
}

/**
 * The step to show: the requested one when the real state allows it, else the step the state calls for.
 *  - no files: always 'upload';
 *  - files still being processed: 'processing' (more files can be added there);
 *  - all initial files finished with at least one ready: 'outline' (also the default), 'processing' stays reachable;
 *  - all finished and none ready: 'processing' (retry, remove or add files).
 */
export function resolveSetupStep(requested: string | null | undefined, state: SetupState): SetupStep {
  if (state.sourceCount === 0) return 'upload'
  if (!state.initialFinished) return 'processing'
  if (state.readyInitialCount === 0) return 'processing'
  if (requested === 'processing') return 'processing'
  return 'outline'
}
