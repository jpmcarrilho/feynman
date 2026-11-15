import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { prisma } from '@/lib/db'
import { isValidFileId, isValidSummaryKey } from '@/lib/fileLinks'
import { findSessionIndexFile, findSummaryFile } from '@/server/storage'

function markdown(file: string, title: string) {
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'inline',
      'X-File-Title': encodeURIComponent(title),
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** ?course=<courseId>&key=<key> (module summary) or ?session=<sessionId> (session index). */
export async function GET(request: NextRequest) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })

  const sp = request.nextUrl.searchParams
  const session = sp.get('session')
  const course = sp.get('course')
  const key = sp.get('key')

  try {
    if (session) {
      if (!isValidFileId(session)) return new NextResponse('Not found', { status: 404 })
      const file = findSessionIndexFile(session)
      return file ? markdown(file, 'Session Study Guides') : new NextResponse('Not found', { status: 404 })
    }

    if (!course || !key || !isValidFileId(course) || !isValidSummaryKey(key)) {
      return new NextResponse('Not found', { status: 404 })
    }
    const row = await prisma.course.findUnique({ where: { id: course }, select: { id: true, code: true } })
    if (!row) return new NextResponse('Not found', { status: 404 })
    const file = findSummaryFile(row, key)
    if (!file) return new NextResponse('Not found', { status: 404 })
    return markdown(file, `Study Guide: ${key.replace(/\.md$/, '').replace(/_+/g, ' ')}`)
  } catch (error) {
    console.error('Error serving summary:', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}
