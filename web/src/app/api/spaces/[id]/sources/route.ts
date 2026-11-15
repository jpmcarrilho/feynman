import { NextRequest, NextResponse } from 'next/server'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { prisma } from '@/lib/db'
import { isValidFileId } from '@/lib/fileLinks'
import { MAX_REQUEST_BYTES, MAX_FILES_PER_REQUEST } from '@/lib/ingestLimits'
import { addSourcesToSpace, UploadRejected, SpaceNotFoundError, type UploadFile } from '@/server/ingest/upload'

// Node.js runtime: the pipeline uses the filesystem, SQLite and pdf-parse (route.md: "export const runtime = 'nodejs'").
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

class RequestTooLarge extends Error {}

/**
 * The body stream with a hard byte limit: whatever Content-Length says, the read ends with an error once more than `max` bytes
 * arrived, so a request cannot make `formData()` buffer more than that.
 */
function limitBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > max) controller.error(new RequestTooLarge())
        else controller.enqueue(chunk)
      },
    }),
  )
}

const json = (body: unknown, status: number) => NextResponse.json(body, { status })

/**
 * Upload of files to a studyspace: multipart form with `files` (one or more) and `bundle` (`initial` | `later`, default `initial`).
 * Order: authentication (401, the body is not touched), studyspace (404), request size (413), form parse (400), then the checks
 * of every file together (count, extension 415, size 413, empty, duplicate names, first bytes 415); only if all pass anything is
 * written. 201 { sources: [{ id, originalName, status, sizeBytes, nameAlreadyInSpace }] }; the files are processed in the background.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })

  const { id } = await params
  if (!isValidFileId(id)) return json({ error: 'Studyspace not found.' }, 404)
  const course = await prisma.course.findUnique({ where: { id }, select: { id: true } })
  if (!course) return json({ error: 'Studyspace not found.' }, 404)

  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !request.body) {
    return json({ error: 'Send the files as a multipart form (field "files").' }, 400)
  }
  const tooLarge = () => json({ error: `The upload is larger than ${MAX_REQUEST_BYTES / (1024 * 1024)} MB. Upload fewer or smaller files at a time.` }, 413)
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return tooLarge()

  let form: FormData
  try {
    // A new Request over the limited stream; formData() then reads the multipart body from it
    form = await new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: limitBody(request.body, MAX_REQUEST_BYTES),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }).formData()
  } catch (error) {
    if (error instanceof RequestTooLarge || (error as { cause?: unknown })?.cause instanceof RequestTooLarge) return tooLarge()
    return json({ error: 'The upload could not be read. Try again.' }, 400)
  }

  const bundleField = form.get('bundle')
  if (bundleField !== null && bundleField !== 'initial' && bundleField !== 'later') return json({ error: 'Unknown bundle.' }, 400)
  const bundle = bundleField === 'later' ? 'later' : 'initial'

  const files: UploadFile[] = form.getAll('files').flatMap((v) => (typeof v === 'object' && v !== null && 'arrayBuffer' in v ? [{ name: (v as File).name, size: (v as File).size, blob: v as File }] : []))
  if (files.length > MAX_FILES_PER_REQUEST) {
    return json({ error: `Too many files (${files.length}). Upload at most ${MAX_FILES_PER_REQUEST} files at a time.` }, 413)
  }

  try {
    const sources = await addSourcesToSpace(id, bundle, files)
    return json({ sources }, 201)
  } catch (error) {
    if (error instanceof UploadRejected) {
      return json({ error: error.message, files: error.problems.map((p) => ({ name: p.name, error: p.error })) }, error.status)
    }
    if (error instanceof SpaceNotFoundError) return json({ error: error.message }, 404)
    console.error('[upload] failed:', error)
    return json({ error: 'The files could not be saved. Try again.' }, 500)
  }
}
