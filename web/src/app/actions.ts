'use server'

import { generateText, generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { prisma } from '@/lib/db'
import { z } from 'zod'

export async function explainMistake({
  questionText,
  choices,
  correctAnswer,
  userAnswer,
  explanation,
  topicTitle
}: {
  questionText: string,
  choices: string[],
  correctAnswer: string,
  userAnswer: string,
  explanation?: string | null,
  topicTitle?: string
}) {
  const prompt = `You are an expert tutor for the MIT DEDP MicroMasters.
The student answered a multiple choice question incorrectly.

Topic: ${topicTitle || 'Unknown'}
Question: ${questionText}
Choices:
${choices.map(c => `- ${c}`).join('\n')}

Correct Answer: ${correctAnswer}
Student's Answer: ${userAnswer}

Official Explanation: ${explanation || 'None provided.'}

Your task: Gently explain to the student why their answer is incorrect and why the correct answer is right. Use the official explanation if available, but break it down so it's easy to understand. Be encouraging.`

  try {
    const { text } = await generateText({
      model: google('gemini-2.5-flash'), // You can also use gemini-2.0-flash
      prompt,
    })
    return text
  } catch (error: any) {
    console.error('Error generating explanation:', error)
    return 'Sorry, I encountered an error while trying to explain this mistake. Please review the official explanation if available.'
  }
}

export async function getTopics() {
  return prisma.topic.findMany({
    orderBy: { week: 'asc' },
    include: { course: true }
  })
}

export async function createStudySession(topicIds: string[], count: number) {
  let selected: any[] = []

  if (topicIds.length > 0) {
    const exercises = await prisma.exercise.findMany({
      where: { topicId: { in: topicIds } },
      include: { topic: true }
    })
    
    // Shuffle
    const shuffled = exercises.sort(() => 0.5 - Math.random())
    selected = shuffled.slice(0, count)

    // Generate remaining exercises if we don't have enough
    if (selected.length < count) {
      const needed = count - selected.length
      const topics = await prisma.topic.findMany({
        where: { id: { in: topicIds } }
      })
      
      const topicsContext = topics.map(t => `ID: ${t.id} - Title: ${t.title}`).join('\n')

      try {
        const { object } = await generateObject({
          model: google('gemini-2.5-flash'),
          prompt: `Generate ${needed} multiple-choice exercises for an MIT economics course. Use the following topics:
${topicsContext}

The questions should be challenging but educational. Each exercise MUST use one of the exactly provided topic IDs.`,
          schema: z.object({
            exercises: z.array(z.object({
              topicId: z.string(),
              questionText: z.string(),
              choices: z.array(z.string()).min(2).max(5),
              correctAnswer: z.string(),
              explanation: z.string()
            }))
          })
        })

        for (const genEx of object.exercises) {
          // Fallback to random topic if hallucinated
          const validTopicId = topicIds.includes(genEx.topicId) ? genEx.topicId : topicIds[Math.floor(Math.random() * topicIds.length)]
          
          const newEx = await prisma.exercise.create({
            data: {
              topicId: validTopicId,
              questionText: genEx.questionText,
              choices: JSON.stringify(genEx.choices),
              correctAnswer: genEx.correctAnswer,
              explanation: genEx.explanation
            },
            include: { topic: true }
          })
          selected.push(newEx)
        }
      } catch (e) {
        console.error("Failed to generate exercises:", e)
      }
    }
  } else {
    // Random selection across all topics
    const exercises = await prisma.exercise.findMany({
      include: { topic: true }
    })
    const shuffled = exercises.sort(() => 0.5 - Math.random())
    selected = shuffled.slice(0, count)
  }

  const session = await prisma.studySession.create({
    data: {
      status: 'active',
      exerciseIds: JSON.stringify(selected.map((e: any) => e.id))
    },
    include: { logs: true }
  })

  return { session, exercises: selected }
}

export async function logAnswer(sessionId: string, exerciseId: string, isCorrect: boolean, duration: number, userAnswer?: string) {
  await prisma.exerciseLog.create({
    data: {
      sessionId,
      exerciseId,
      isCorrect,
      userAnswer,
      duration
    }
  })
}

export async function saveChatLog(sessionId: string, messages: any[]) {
  await prisma.studySession.update({
    where: { id: sessionId },
    data: { chatLog: JSON.stringify(messages) }
  })
}

export async function getSessionHistory() {
  return prisma.studySession.findMany({
    orderBy: { startTime: 'desc' },
    take: 10,
    include: { logs: { include: { exercise: true } } }
  })
}

export async function getSessionWithExercises(sessionId: string) {
  const session = await prisma.studySession.findUnique({
    where: { id: sessionId },
    include: { logs: { include: { exercise: true } } }
  })
  
  if (!session || !session.exerciseIds) return null

  const ids = JSON.parse(session.exerciseIds) as string[]
  const exercises = await prisma.exercise.findMany({
    where: { id: { in: ids } },
    include: { topic: { include: { course: true } } }
  })

  // Restore original order
  const orderedExercises = ids.map(id => exercises.find(e => e.id === id)).filter(Boolean)

  return { session, exercises: orderedExercises }
}
