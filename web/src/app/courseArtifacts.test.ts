import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getCourseArtifacts, generateWeekSummaryAction } from './actions'
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

describe('getCourseArtifacts action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('correctly maps courses and topics into weeks structure', async () => {
    // 1. Mock Database response
    const mockCourses = [
      { id: 'course-1', code: '14.750x', title: 'Political Economy', description: null }
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

    // 2. Execute Action
    const results = await getCourseArtifacts()

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
  })
})

describe('generateWeekSummaryAction action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates a new Feynman study guide summary when it does not exist', async () => {
    // 1. Mock DB and fs
    const mockCourse = { id: 'course-1', code: '14.750x', title: 'Political Economy', description: null }
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

    // 2. Execute Action
    const result = await generateWeekSummaryAction('14.750x', 'Week_01')

    // 3. Assertions
    expect(prisma.course.findUnique).toHaveBeenCalledWith({ where: { code: '14.750x' } })
    expect(prisma.topic.findMany).toHaveBeenCalledWith({ where: { courseId: 'course-1', week: 'Week_01' } })
    expect(generateText).toHaveBeenCalled()
    expect(fs.writeFileSync).toHaveBeenCalled()
    expect(result.content).toBe('# 📓 Feynman Study Guide content')
  })

  it('serves existing Feynman study guide if it exists on disk', async () => {
    const mockCourse = { id: 'course-1', code: '14.750x', title: 'Political Economy', description: null }
    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce(mockCourse)
    
    // Summary file exists
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      if (filePath.toString().endsWith('.md')) {
        return true;
      }
      return true;
    })
    vi.mocked(fs.readFileSync).mockReturnValueOnce('# 📓 Existing Feynman Study Guide')

    const result = await generateWeekSummaryAction('14.750x', 'Week_01')

    expect(fs.readFileSync).toHaveBeenCalled()
    expect(generateText).not.toHaveBeenCalled()
    expect(result.content).toBe('# 📓 Existing Feynman Study Guide')
  })
})