// Adding uploaded files to a studyspace (plan 4.1, 4.3). The upload route is a thin shell around addSourcesToSpace.
//
// Order: (1) check the whole list (count, extension, declared size, empty, duplicate names), (2) read the first bytes of every
// file and sniff them, (3) only then write anything: originals to storage, then all Source rows in ONE transaction, then queue.
// A failure at any point removes the files written so far, so neither rows nor files are left behind. (A crash of the
// process between writing the files and the transaction can leave unreferenced folders under storage/sources; nothing
// references them and nothing shows them.)
//
// Names are untrusted data: the sanitized original name is stored in the row for display; the storage key is built from ids
// and a whitelisted extension only. A file whose name is already used in the studyspace is accepted as a separate source
// (a corrected re-upload is legitimate); the result says so.
import { prisma } from '@/lib/db'
import { extensionOf, checkUploadList, mimeTypeForExtension, sanitizeFileName, type UploadProblem } from '@/lib/ingestLimits'
import { writeSourceBlob, removeSourceFiles } from '@/server/storage'
import { sniffUploadHead, UPLOAD_SNIFF_BYTES } from './extract'
import { enqueueSource } from './runner'
import { courseHasTutor } from './profileState'

export type UploadFile = { name: string; size: number; blob: Blob }
export type AddedSource = { id: string; originalName: string; status: string; sizeBytes: number; nameAlreadyInSpace: boolean }

export class UploadRejected extends Error {
  readonly problems: UploadProblem[]
  readonly status: 400 | 413 | 415
  constructor(problems: UploadProblem[]) {
    super(problems[0]?.error ?? 'The upload was refused.')
    this.name = 'UploadRejected'
    this.problems = problems
    this.status = problems[0]?.status ?? 400
  }
}

export class SpaceNotFoundError extends Error {
  constructor() {
    super('Studyspace not found.')
    this.name = 'SpaceNotFoundError'
  }
}

/**
 * Validates every file, then stores them all and queues them. `requestedBundle` is only what the client asked for; see `bundle` below. Throws UploadRejected before anything is written when a file is
 * not acceptable, SpaceNotFoundError when the studyspace does not exist. Returns the created sources in upload order.
 */
export async function addSourcesToSpace(courseId: string, requestedBundle: 'initial' | 'later', files: UploadFile[]): Promise<AddedSource[]> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true } })
  if (!course) throw new SpaceNotFoundError()
  // The server decides, whatever the client sent: a studyspace that already has a tutor (accepted profile, or one of the two imported
  // studyspaces) takes `later` files, which run the whole pipeline including starter questions; any other takes `initial` files.
  const bundle: 'initial' | 'later' = (await courseHasTutor(courseId)) ? 'later' : 'initial'
  void requestedBundle
  const named = files.map((f) => ({ ...f, name: sanitizeFileName(f.name) }))
  const problems = checkUploadList(named)
  if (problems.length > 0) throw new UploadRejected(problems)

  // Sniff the first bytes of every file before the first write
  const sniffProblems: UploadProblem[] = []
  for (const f of named) {
    const head = new Uint8Array(await f.blob.slice(0, UPLOAD_SNIFF_BYTES).arrayBuffer())
    const message = sniffUploadHead(extensionOf(f.name), head)
    if (message) sniffProblems.push({ name: f.name, error: `"${f.name}": ${message}`, status: 415 })
  }
  if (sniffProblems.length > 0) throw new UploadRejected(sniffProblems)

  const existing = new Set(
    (await prisma.source.findMany({ where: { courseId }, select: { originalName: true } })).map((s) => s.originalName.toLowerCase()),
  )

  const base = Date.now()
  const planned = named.map((f, i) => {
    const ext = extensionOf(f.name)
    return { id: crypto.randomUUID(), file: f, ext, createdAt: new Date(base + i) }
  })
  const written: string[] = []
  const cleanup = async () => {
    for (const id of written) await removeSourceFiles(courseId, id).catch(() => {})
  }
  try {
    const keys: string[] = []
    for (const p of planned) {
      written.push(p.id)
      keys.push(await writeSourceBlob(courseId, p.id, p.ext, p.file.blob))
    }
    await prisma.$transaction(
      planned.map((p, i) =>
        prisma.source.create({
          data: {
            id: p.id, courseId, originalName: p.file.name, mimeType: mimeTypeForExtension(p.ext), sizeBytes: p.file.size,
            storageKey: keys[i], bundle, status: 'uploaded', createdAt: p.createdAt,
          },
        }),
      ),
    )
  } catch (error) {
    await cleanup()
    throw error
  }

  for (const p of planned) enqueueSource(p.id)
  return planned.map((p) => ({
    id: p.id, originalName: p.file.name, status: 'uploaded', sizeBytes: p.file.size, nameAlreadyInSpace: existing.has(p.file.name.toLowerCase()),
  }))
}
