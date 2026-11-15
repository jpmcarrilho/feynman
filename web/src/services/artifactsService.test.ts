import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getCourseArtifactsService, generateWeekSummaryService, uploadedDetail } from './artifactsService'
import { generateText } from 'ai'
import { prisma } from '@/lib/db'
import fs from 'fs'

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}))

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn(() => 'mocked-google-model'),
}))

// Mock the database client
vi.mock('@/lib/db', () => ({
  prisma: {
    course: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    topic: {
      findMany: vi.fn(),
    },
    exercise: {
      findMany: vi.fn(),
    },
  },
}))

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
}))

describe('getCourseArtifactsService course scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.course.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
  })

  it('reads only the given course and its topics, in module then outline order', async () => {
    await getCourseArtifactsService('course-1')
    expect(prisma.course.findMany).toHaveBeenCalledWith({ where: { id: 'course-1' }, orderBy: { code: 'asc' } })
    expect(vi.mocked(prisma.topic.findMany).mock.calls[0][0]).toMatchObject({
      where: { courseId: 'course-1' },
      orderBy: [{ week: 'asc' }, { order: 'asc' }],
    })
  })

  it('reads every course without a scope', async () => {
    await getCourseArtifactsService()
    expect(vi.mocked(prisma.course.findMany).mock.calls[0][0]).toMatchObject({ where: undefined })
    expect(vi.mocked(prisma.topic.findMany).mock.calls[0][0]).toMatchObject({ where: undefined })
  })
})

describe('getCourseArtifactsService: files added to an imported studyspace', () => {
  beforeEach(() => vi.clearAllMocks())

  const topic = (id: string, week: string, order: number, over: Record<string, unknown> = {}) => ({
    id, courseId: 'course-1', week, className: 'Class', unit: '1', title: id, resourceType: 'Transcript .txt', localPath: 'x.txt', content: 'c', order, sourceId: null, source: null, pageStart: null, pageEnd: null,
    course: { code: '14.750x' }, exercises: [], ...over,
  })

  it('lists the uploaded modules and their topics after the imported modules, in outline order, and links them through the topic link', async () => {
    vi.mocked(prisma.course.findMany).mockResolvedValueOnce([{ id: 'course-1', code: '14.750x', title: 'PE', description: null, profile: null, profileSuggestion: null, goal: null, starterStatus: 'done', createdAt: new Date(0) }] as never)
    // the database returns them sorted by week label: "04 · ..." sorts before "Week_..."
    vi.mocked(prisma.topic.findMany).mockResolvedValueOnce([
      topic('up-b', '05 · Second added module', 41, { sourceId: 's1', resourceType: 'Uploaded text', localPath: null, source: { originalName: 'notes.md', mimeType: 'text/markdown' } }),
      topic('up-a', '04 · First added module', 40, { sourceId: 's1', resourceType: 'Uploaded PDF', localPath: null, pageStart: 3, pageEnd: 4, source: { originalName: 'deck.pdf', mimeType: 'application/pdf' } }),
      topic('imp-1', 'Week_01_Intro', 0),
      topic('imp-2', 'Week_02_Voting', 10),
    ] as never)
    const [course] = await getCourseArtifactsService('course-1')
    expect(course.weeks.map((w) => w.weekName)).toEqual(['Week_01_Intro', 'Week_02_Voting', '04 · First added module', '05 · Second added module'])
    const pdf = course.weeks[2].slides[0]
    expect(pdf).toMatchObject({ id: 'up-a', detail: 'deck.pdf · pages 3-4', link: '/api/files/topic/up-a#page=3' })
    expect(course.weeks[3].transcriptions[0]).toMatchObject({ id: 'up-b', detail: 'notes.md', link: '/api/files/topic/up-b' })
  })
})

describe('getCourseArtifactsService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('correctly maps courses and topics into weeks structure', async () => {
    // 1. Mock Database response
    const mockCourses = [
      { id: 'course-1', code: '14.750x', title: 'Political Economy', description: null, profile: null, profileSuggestion: null, goal: null, starterStatus: null, createdAt: new Date(0) }
    ]
    const mockTopics = [
      {
        id: 'topic-1',
        courseId: 'course-1',
        week: 'Week_01_Intro',
        className: 'Intro Class',
        unit: '1',
        title: 'Slides and Intro',
        resourceType: 'Slides PDF',
        localPath: '14.750x/Week_01_Intro/slides.pdf',
        content: 'Slides text content',
        course: { code: '14.750x' },
        exercises: [{ id: 'ex-1' }]
      },
      {
        id: 'topic-2',
        courseId: 'course-1',
        week: 'Week_01_Intro',
        className: 'Intro Class',
        unit: '2',
        title: 'Transcripts Unit',
        resourceType: 'Transcript .txt',
        localPath: '14.750x/Week_01_Intro/transcript.txt',
        content: 'Transcripts text content',
        course: { code: '14.750x' },
        exercises: []
      }
    ]

    vi.mocked(prisma.course.findMany).mockResolvedValueOnce(mockCourses)
    vi.mocked(prisma.topic.findMany).mockResolvedValueOnce(mockTopics as any)
    vi.mocked(fs.existsSync).mockReturnValue(true) // summary exists

    // 2. Execute Service
    const results = await getCourseArtifactsService()

    // 3. Assertions
    expect(prisma.course.findMany).toHaveBeenCalled()
    expect(prisma.topic.findMany).toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0].courseCode).toBe('14.750x')
    expect(results[0].weeks).toHaveLength(1)
    
    const week = results[0].weeks[0]
    expect(week.weekName).toBe('Week_01_Intro')
    expect(week.summaryExists).toBe(true)
    expect(week.slides).toHaveLength(1)
    expect(week.slides[0].title).toBe('Slides and Intro')
    expect(week.transcriptions).toHaveLength(1)
    expect(week.transcriptions[0].title).toBe('Transcripts Unit')
    expect(week.exercisesCount).toBe(1)
    // Only imported, active questions are "ingested": generated, rejected and reported ones are not counted
    expect(prisma.topic.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ exercises: { where: { origin: 'imported', status: 'active', isGraded: true }, select: { id: true } } }),
    }))
  })
})

describe('generateWeekSummaryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates a new Feynman study guide summary when it does not exist', async () => {
    // 1. Mock DB and fs
    const mockCourse = { id: 'course-1', code: '14.750x', title: 'Political Economy', description: null, profile: null, profileSuggestion: null, goal: null, starterStatus: null, createdAt: new Date(0) }
    const mockTopics = [
      { id: 'topic-1', courseId: 'course-1', week: 'Week_01', className: 'Intro', title: 'Concept', content: 'Very long content '.repeat(2000) } // >15k characters to test truncation
    ]

    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce(mockCourse)
    vi.mocked(prisma.topic.findMany).mockResolvedValueOnce(mockTopics as any)
    vi.mocked(generateText).mockResolvedValueOnce({ text: '# 📓 Feynman Study Guide content' } as any)

    // Robust existsSync mock: directories exist but summary files (.md) do not exist
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      if (filePath.toString().endsWith('.md')) {
        return false;
      }
      return true;
    })

    // 2. Execute Service
    const result = await generateWeekSummaryService('14.750x', 'Week_01')

    // 3. Assertions
    expect(prisma.course.findUnique).toHaveBeenCalledWith({ where: { code: '14.750x' } })
    expect(prisma.topic.findMany).toHaveBeenCalledWith({ where: { courseId: 'course-1', week: 'Week_01' } })
    expect(generateText).toHaveBeenCalled()
    expect(fs.writeFileSync).toHaveBeenCalled()
    expect(result.content).toBe('# 📓 Feynman Study Guide content')
  })

  it('serves existing Feynman study guide if it exists on disk', async () => {
    const mockCourse = { id: 'course-1', code: '14.750x', title: 'Political Economy', description: null, profile: null, profileSuggestion: null, goal: null, starterStatus: null, createdAt: new Date(0) }
    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce(mockCourse)
    
    // Summary file exists
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      if (filePath.toString().endsWith('.md')) {
        return true;
      }
      return true;
    })
    vi.mocked(fs.readFileSync).mockReturnValueOnce('# 📓 Existing Feynman Study Guide')

    const result = await generateWeekSummaryService('14.750x', 'Week_01')

    expect(fs.readFileSync).toHaveBeenCalled()
    expect(generateText).not.toHaveBeenCalled()
    expect(result.content).toBe('# 📓 Existing Feynman Study Guide')
  })
})
describe('getCourseArtifactsService topic links', () => {
  it('opens an uploaded topic at its first page and leaves legacy topics (no source) with a plain link', async () => {
    vi.mocked(prisma.course.findMany).mockResolvedValue([{ id: 'c1', code: 'c1', title: 'T' }] as never)
    const topic = (id: string, over: object) => ({ id, courseId: 'c1', week: '01 · A', title: id, unit: '1', className: 'f', resourceType: 'Uploaded PDF', localPath: null, exercises: [], sourceId: null, pageStart: null, ...over })
    vi.mocked(prisma.topic.findMany).mockResolvedValue([
      topic('up', { sourceId: 's1', pageStart: 7 }),
      topic('up-text', { sourceId: 's2', pageStart: null, resourceType: 'Uploaded text' }),
      topic('legacy', { resourceType: 'Slides', pageStart: 3 }),
    ] as never)
    const [course] = await getCourseArtifactsService('c1')
    const links = Object.fromEntries([...course.weeks[0].slides, ...course.weeks[0].transcriptions].map((r: { id: string; link: string }) => [r.id, r.link]))
    expect(links).toEqual({ up: '/api/files/topic/up#page=7', 'up-text': '/api/files/topic/up-text', legacy: '/api/files/topic/legacy' })
  })
})

describe('uploadedDetail', () => {
  const pdf = { originalName: 'engines.pdf', mimeType: 'application/pdf' }
  it('shows file and pages for uploaded PDFs, the file only for text, nothing for imported topics', () => {
    expect(uploadedDetail({ sourceId: 's', pageStart: 3, pageEnd: 4, source: pdf })).toBe('engines.pdf · pages 3-4')
    expect(uploadedDetail({ sourceId: 's', pageStart: 2, pageEnd: 2, source: pdf })).toBe('engines.pdf · page 2')
    expect(uploadedDetail({ sourceId: 's', pageStart: 2, pageEnd: null, source: pdf })).toBe('engines.pdf · page 2')
    expect(uploadedDetail({ sourceId: 's', pageStart: 1, pageEnd: 2, source: { originalName: 'n.md', mimeType: 'text/markdown' } })).toBe('n.md')
    expect(uploadedDetail({ sourceId: null, pageStart: 3, pageEnd: 4 })).toBeNull()
  })
})
