import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { prisma } from '@/lib/db'
import { isValidFileId } from '@/lib/fileLinks'
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

    if (topic.content) return fileResponse(topic.content, 'text/plain; charset=utf-8', topic.title)
    return new NextResponse('Not found', { status: 404 })
  } catch (error) {
    console.error('Error serving topic file:', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}
