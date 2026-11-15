// "A tutor-update check is running or queued for this studyspace", kept on globalThis so every bundle of the Node process (the runner's
// hook, the server actions that answer the status poll) sees the same value. No imports: safe to load from anywhere.
type Holder = { __feynmanUpdateChecks?: Map<string, number> }
const counts = (): Map<string, number> => ((globalThis as Holder).__feynmanUpdateChecks ??= new Map())

export function beginUpdateCheck(courseId: string): void {
  counts().set(courseId, (counts().get(courseId) ?? 0) + 1)
}

export function endUpdateCheck(courseId: string): void {
  const left = (counts().get(courseId) ?? 1) - 1
  if (left <= 0) counts().delete(courseId)
  else counts().set(courseId, left)
}

export function isUpdateCheckPending(courseId: string): boolean {
  return (counts().get(courseId) ?? 0) > 0
}
