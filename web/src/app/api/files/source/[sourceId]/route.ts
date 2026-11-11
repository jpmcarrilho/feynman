import { NextRequest, NextResponse } from 'next/server'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { prisma } from '@/lib/db'
import { isValidFileId } from '@/lib/fileLinks'
import { readSourceFile, safeSourceContentType } from '@/server/storage'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })

  const { sourceId } = await params
  if (!isValidFileId(sourceId)) return new NextResponse('Not found', { status: 404 })

  try {
    const source = await prisma.source.findUnique({
      where: { id: sourceId },
      select: { originalName: true, mimeType: true, storageKey: true },
    })
    if (!source) return new NextResponse('Not found', { status: 404 })

    let bytes: Buffer
    try {
      bytes = await readSourceFile(source.storageKey)
    } catch {
      return new NextResponse('Not found', { status: 404 })
    }
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': safeSourceContentType(source.mimeType),
        'Content-Disposition': 'inline',
        'X-File-Title': encodeURIComponent(source.originalName),
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('Error serving source file:', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}
