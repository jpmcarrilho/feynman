import { generateText } from 'ai'
import { textModel } from '@/lib/ai'
import { moduleSummaryPrompt } from '@/lib/prompts'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'
import { prisma } from '@/lib/db'
import fs from 'fs'
import path from 'path'

export async function createSessionSummary(sessionId: string) {
  // 1. Get session details
  const session = await prisma.studySession.findUnique({
    where: { id: sessionId },
    include: { logs: { include: { exercise: true } } }
  })

  if (!session) {
    throw new Error('Session not found')
  }

  // 2. Retrieve ALL exercises configured for this entire session (not just the logged/answered ones)
  if (!session.exerciseIds) {
    throw new Error('No exercises configured for this session')
  }
  const exerciseIds = JSON.parse(session.exerciseIds) as string[]

  const exercises = await prisma.exercise.findMany({
    where: { id: { in: exerciseIds } },
    include: { topic: { include: { course: true } } }
  })

  // 3. Group exercises and topics by Course and Week
  const weekGroups = new Map<string, { courseCode: string, weekName: string, exercises: typeof exercises }>()

  exercises.forEach(ex => {
    if (ex.topic && ex.topic.week && ex.topic.course) {
      const courseCode = ex.topic.course.code
      const weekName = ex.topic.week.replace(/\s+/g, '_') // safe filesystem naming, e.g. Week_01
      const groupKey = `${courseCode}_${weekName}`
      
      if (!weekGroups.has(groupKey)) {
        weekGroups.set(groupKey, { courseCode, weekName: ex.topic.week, exercises: [] })
      }
      weekGroups.get(groupKey)!.exercises.push(ex)
    }
  })

  const summariesDir = path.join(process.cwd(), 'summaries')
  if (!fs.existsSync(summariesDir)) {
    fs.mkdirSync(summariesDir, { recursive: true })
  }

  const results: { courseCode: string, weekName: string, filePath: string, reloaded: boolean }[] = []

  // 4. Generate or re-load summaries for each week covered in the session
  for (const [groupKey, group] of weekGroups.entries()) {
    const courseDir = path.join(summariesDir, group.courseCode)
    if (!fs.existsSync(courseDir)) {
      fs.mkdirSync(courseDir, { recursive: true })
    }

    const weekFileSlug = group.weekName.replace(/\s+/g, '_')
    const weekSummaryFilePath = path.join(courseDir, `${weekFileSlug}.md`)

    // Check if the Feynman study guide for this week has already been generated as a permanent asset
    if (fs.existsSync(weekSummaryFilePath)) {
      results.push({
        courseCode: group.courseCode,
        weekName: group.weekName,
        filePath: weekSummaryFilePath,
        reloaded: true
      })
      continue
    }

    // If it doesn't exist, we generate it from the week's lesson transcripts and outlines
    // Find all topics under the same course and week to capture the entire lecture outlines and transcriptions
    const course = await prisma.course.findUnique({ where: { code: group.courseCode } })
    if (!course) continue

    const classTopics = await prisma.topic.findMany({
      where: {
        courseId: course.id,
        week: group.weekName
      }
    })

    let materialContext = ''
    classTopics.forEach(t => {
      let topicContent = t.content || 'No outline transcription available.'
      if (topicContent.length > 15000) {
        topicContent = topicContent.substring(0, 15000) + '\n\n[...Content truncated for context efficiency...]'
      }
      materialContext += `--- Lesson Name: ${t.className || 'Unknown'} | Topic Unit: ${t.title} ---\n`
      materialContext += `Content/Transcription Outline:\n${topicContent}\n`
      materialContext += `Local Slides/Reading Path: ${t.localPath || 'None'}\n\n`
    })

    const prompt = moduleSummaryPrompt(resolveProfile(course), {
      courseCode: group.courseCode,
      courseTitle: course.title,
      module: group.weekName,
      material: materialContext,
    })

    try {
      const { text } = await generateText({
        model: textModel(),
        prompt,
      })

      fs.writeFileSync(weekSummaryFilePath, text, 'utf8')

      results.push({
        courseCode: group.courseCode,
        weekName: group.weekName,
        filePath: weekSummaryFilePath,
        reloaded: false
      })
    } catch (error) {
      console.error(`Error generating week summary for ${groupKey}:`, error)
      throw error
    }
  }

  // 5. Handle master index generation if multiple weeks are covered in the session
  if (results.length === 1) {
    // If only one week is covered, serve its study guide directly!
    const singleResult = results[0]
    const content = fs.readFileSync(singleResult.filePath, 'utf8')
    return { filePath: singleResult.filePath, content }
  } else {
    // If multiple weeks are covered, generate an interactive Master Index file on the fly!
    let indexMarkdown = `# 📓 Feynman Session Study Guides\n`
    indexMarkdown += `This study session covers multiple weeks of material. We have retrieved and prepared dedicated Feynman study guides for each week. Click on a link below to open its comprehensive study guide:\n\n`
    
    results.forEach(res => {
      const statusText = res.reloaded ? '⚡ Loaded from memory asset' : '✨ Freshly compiled by AI'
      indexMarkdown += `* 📖 [**${res.courseCode} - ${res.weekName} Study Guide**](/api/file?path=${encodeURIComponent(res.filePath)}) \n  *(${statusText} | PDF/Slides-grounded)*\n\n`
    })

    indexMarkdown += `---\n`
    indexMarkdown += `*Note: Week summaries are permanently saved on disk under \`/summaries/\`. Any future session covering these weeks will re-load them instantly in milliseconds!*`

    const sessionIndexFilePath = path.join(summariesDir, `session_${sessionId}_index.md`)
    fs.writeFileSync(sessionIndexFilePath, indexMarkdown, 'utf8')

    return { filePath: sessionIndexFilePath, content: indexMarkdown }
  }
}
