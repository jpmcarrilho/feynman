import { generateText } from 'ai'
import { google } from '@ai-sdk/google'
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

  // 3. Gather lesson materials & transcription content for ALL topics in the entire session
  const topicIds = Array.from(new Set(exercises.map(ex => ex.topicId).filter(Boolean))) as string[]
  
  let materialContext = ''
  for (const topicId of topicIds) {
    const topic = await prisma.topic.findUnique({ 
      where: { id: topicId },
      include: { course: true }
    })
    
    if (topic && topic.className) {
      // Find all topics in the same class (lesson) to capture full slideshow and outline content
      const classTopics = await prisma.topic.findMany({
        where: {
          courseId: topic.courseId,
          week: topic.week,
          className: topic.className
        },
        include: { course: true }
      })
      
      for (const t of classTopics) {
        materialContext += `--- Course: ${t.course?.title || 'MIT DEDP'} | Class: ${t.className} | Topic Unit: ${t.title} ---\n`
        materialContext += `Content/Transcription Outline:\n${t.content || 'No outline transcription available.'}\n`
        materialContext += `Local Slide/Reading Path: ${t.localPath || 'None'}\n\n`
      }
    }
  }

  // 4. Compile the student's actual performance so far
  let performanceContext = ''
  const logsMap = new Map(session.logs.map(log => [log.exerciseId, log]))
  
  exercises.forEach((ex, index) => {
    const log = logsMap.get(ex.id)
    performanceContext += `Question ${index + 1}: ${ex.questionText}\n`
    performanceContext += `Choices: ${ex.choices}\n`
    performanceContext += `Correct Answer: ${ex.correctAnswer}\n`
    if (log) {
      performanceContext += `Student's Answer: ${log.userAnswer || 'Skipped'}\n`
      performanceContext += `Was Correct: ${log.isCorrect ? 'YES' : 'NO'}\n`
    } else {
      performanceContext += `Student's Answer: (Unanswered Yet)\n`
    }
    performanceContext += `Professor's Explanation: ${ex.explanation || 'None'}\n\n`
  })

  // 5. Build strict Feynman prompt
  const prompt = `You are a brilliant, world-class professor specializing in economics and public policy (MIT MicroMasters style), embodying the Feynman learning philosophy.
Your task is to generate a comprehensive, highly detailed study guide and study session summary for a student based on their entire study session.

CRITICAL DIRECTIVES:
1. Grounded in Source Materials: Do NOT simply repeat or summarize the question texts. You must use the actual Covered Material Context (the lecture transcripts, slides outlines, and textbook readings) to summarize and explain the core academic concepts. 
2. The summary must cover ALL topics, weeks, and slides configured for this entire session (not just the current or answered questions).
3. Be concise and simplified: Adhere to the Feynman Technique of making concepts incredibly simple and intuitive using elegant, grounded analogies (like bongos, water-flows, or balance scales), but do not be overly verbose or repetitive.

Covered Material Context (Extracted slides, transcripts, and reading content):
${materialContext || 'No raw lesson materials available.'}

Student's Performance Context (All exercises in the study session):
${performanceContext}

Generate a beautifully styled Markdown document. Break it down into these exact sections:
1. # 📓 Feynman Session Summary & Study Guide
   A high-level executive summary of what was covered across the entire session, the courses involved, overall performance so far, and the general learning objectives.
2. ## 🧠 Concepts Demystified (Feynman Style)
   Pick the main 2-3 core academic concepts covered in this study session's lecture content. Explain each one in simple terms, using an elegant analogy to convey the underlying economics or public policy intuition.
3. ## 🔍 Performance & Pitfall Analysis
   For any questions answered incorrectly, explain the common pitfall and how to think about the correct answer from first principles. If a question is unanswered, frame it as a preview warning on what to focus on.
4. ## 📝 Custom Class Cheat Sheet
   A bulleted, extremely concise reference summarizing key equations, core definitions, or central principles from these specific lectures.
5. ## 🚀 Recommended Next Steps
   Suggested concrete review goals (e.g., specific weeks, slides, or chapters to focus on).

Ensure all equations are nicely formatted in standard LaTeX format when appropriate (wrap math blocks in $$ block $$ or $ inline $).`

  try {
    const { text } = await generateText({
      model: google('gemini-3.6-flash'),
      prompt,
    })

    // 6. Ensure directory and write to disk
    const summariesDir = path.join(process.cwd(), 'summaries')
    if (!fs.existsSync(summariesDir)) {
      fs.mkdirSync(summariesDir, { recursive: true })
    }

    const summaryFilePath = path.join(summariesDir, `session_${sessionId}.md`)
    fs.writeFileSync(summaryFilePath, text, 'utf8')

    return { filePath: summaryFilePath, content: text }
  } catch (error) {
    console.error('Error in createSessionSummary service:', error)
    throw error
  }
}
