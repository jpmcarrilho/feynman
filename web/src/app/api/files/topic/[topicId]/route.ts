import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { prisma } from '@/lib/db'
import { isValidFileId } from '@/lib/fileLinks'
import { CONTENT_TOO_LARGE_MESSAGE, MAX_SERVED_CONTENT_CHARS } from '@/lib/ingestLimits'
import { contentTypeForPath, readSourceFile, safeSourceContentType } from '@/server/storage'

function fileResponse(body: BodyInit, contentType: string, title: string) {
  return new NextResponse(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      'X-File-Title': encodeURIComponent(title),
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

const isPdfType = (mime: string) => (mime || '').split(';')[0].trim().toLowerCase() === 'application/pdf'
const textTypeFor = (mime: string) => ((mime || '').toLowerCase().startsWith('text/markdown') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')

/** Stored text as the response; text beyond a sane size is replaced by a short message (status 200 so the viewer shows it). */
function contentResponse(content: string, contentType: string, title: string) {
  if (content.length > MAX_SERVED_CONTENT_CHARS) return fileResponse(CONTENT_TOO_LARGE_MESSAGE, 'text/plain; charset=utf-8', title)
  return fileResponse(content, contentType, title)
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })

  const { topicId } = await params
  if (!isValidFileId(topicId)) return new NextResponse('Not found', { status: 404 })

  try {
    const topic = await prisma.topic.findUnique({
      where: { id: topicId },
      select: { title: true, sourceId: true, localPath: true, content: true },
    })
    if (!topic) return new NextResponse('Not found', { status: 404 })

    if (topic.sourceId) {
      const source = await prisma.source.findUnique({
        where: { id: topic.sourceId },
        select: { storageKey: true, mimeType: true },
      })
      // A topic of an uploaded .md/.txt is a slice of the file: show its own content, not the whole original
      if (source && !isPdfType(source.mimeType) && topic.content) {
        return contentResponse(topic.content, textTypeFor(source.mimeType), topic.title)
      }
      if (source) {
        try {
          const bytes = await readSourceFile(source.storageKey)
          return fileResponse(new Uint8Array(bytes), safeSourceContentType(source.mimeType), topic.title)
        } catch {
          // The stored file is gone or invalid: fall through to the extracted content below.
        }
      }
    } else if (topic.localPath) {
      // The path comes from the database, never from the request. Directories (question topics) have no file.
      try {
        if (fs.statSync(topic.localPath).isFile()) {
          const bytes = fs.readFileSync(topic.localPath)
          return fileResponse(new Uint8Array(bytes), contentTypeForPath(topic.localPath), topic.title)
        }
      } catch {
        // Missing on disk: fall through to the stored content.
      }
    }

    if (topic.content) return contentResponse(topic.content, 'text/plain; charset=utf-8', topic.title)
    return new NextResponse('Not found', { status: 404 })
  } catch (error) {
    console.error('Error serving topic file:', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}
