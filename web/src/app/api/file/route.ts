import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { prisma } from '@/lib/db'
import { contentTypeForPath, isInside, isLegacyPathAllowed, legacyAllowedRoots } from '@/server/storage'

/**
 * LEGACY route: saved exam diagnoses and chat logs contain /api/file?path=<absolute path> links.
 * It serves only an exact stored Topic.localPath or a .md file inside the summaries directories.
 * New links use /api/files/topic|source|summary.
 */
export async function GET(request: NextRequest) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })

  const filePath = request.nextUrl.searchParams.get('path')
  if (!filePath) return new NextResponse('Missing path parameter', { status: 400 })

  try {
    const topicMatch =
      filePath.length <= 4096 && !filePath.includes('\0')
        ? await prisma.topic.findFirst({ where: { localPath: filePath }, select: { title: true, content: true } })
        : null
    const roots = legacyAllowedRoots()
    if (!isLegacyPathAllowed(filePath, roots, topicMatch !== null)) {
      return new NextResponse('File not found', { status: 404 })
    }

    let target = filePath
    if (topicMatch !== null) {
      // A stored path that is a folder (question topics) or missing on disk: serve the topic's stored content
      let isFile = false
      try {
        isFile = fs.statSync(filePath).isFile()
      } catch {
        isFile = false
      }
      if (!isFile) {
        if (!topicMatch.content) return new NextResponse('File not found', { status: 404 })
        return new NextResponse(topicMatch.content, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline',
            'X-File-Title': encodeURIComponent(topicMatch.title),
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
    } else {
      // Allowed by directory: resolve symlinks and require the real file to stay inside a real root.
      target = fs.realpathSync(path.resolve(filePath))
      const realRoots = roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r))
      if (!realRoots.some((r) => isInside(r, target))) return new NextResponse('File not found', { status: 404 })
    }

    if (!fs.statSync(target).isFile()) return new NextResponse('File not found', { status: 404 })

    return new NextResponse(new Uint8Array(fs.readFileSync(target)), {
      headers: {
        'Content-Type': contentTypeForPath(target),
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return new NextResponse('File not found', { status: 404 })
    console.error('Error serving file:', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}
