import { generateObject } from 'ai'
import { z } from 'zod'
import type { Exercise, Topic } from '@prisma/client'
import { textModel } from '@/lib/ai'
import { prisma } from '@/lib/db'
import { generateExercisePrompt } from '@/lib/prompts'
import { pickQuestionType, type TutorProfile } from '@/lib/studyspace/profile'
import { getCourseWithProfile } from '@/services/studyspaceService'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import { searchTopics, formatSearchResults } from '@/services/contextSearch'

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

function describeExercise(ex: { exerciseType: string; questionText: string; choices: string; correctAnswer: string }): string {
  return `Type: ${ex.exerciseType}\nQuestion: ${ex.questionText}\nChoices: ${ex.choices}\nCorrect Answer: ${ex.correctAnswer}`
}

/** Final-exam-level example questions of the profile's calibration module. '' when the profile has none. */
export async function fetchRigorExamples(courseId: string, profile: TutorProfile): Promise<string> {
  if (!profile.calibrationModule) return ''
  const calibrationTopics = await prisma.topic.findMany({
    where: { courseId, week: profile.calibrationModule },
    select: { id: true },
  })
  const ids = calibrationTopics.map((t) => t.id)
  if (ids.length === 0) return ''
  const rigorExercises = await prisma.exercise.findMany({ where: { topicId: { in: ids } }, take: 3 })
  return rigorExercises.map(describeExercise).join('\n\n')
}

export async function fetchLocalStyleExamples(
  topicData: Pick<Topic, 'week' | 'courseId'>,
  topicIds: string[],
  existingIds: string[],
) {
  // Exercises from the same module (generated ones included)
  let exercises = await prisma.exercise.findMany({
    where: {
      topic: { week: topicData.week, courseId: topicData.courseId },
      id: { notIn: existingIds },
    },
    take: 5,
    include: { topic: true },
  })

  // Fall back to all selected topics when the module has too few
  if (exercises.length < 3) {
    const fallbackExercises = await prisma.exercise.findMany({
      where: { topicId: { in: topicIds }, id: { notIn: existingIds } },
      take: 5 - exercises.length,
      include: { topic: true },
    })
    exercises = [...exercises, ...fallbackExercises]
  }

  return exercises
}

/** Grounding text of the bucket topics; for the calibration module also the search context matching the style examples. */
export async function compileGroundingContext(
  topicData: Pick<Topic, 'week' | 'courseId'>,
  bucketTopics: Pick<Topic, 'title' | 'content'>[],
  localStyleExercises: { questionText: string }[],
  profile: TutorProfile,
): Promise<string> {
  let bucketContext = bucketTopics
    .map((t) => {
      let text = t.content || ''
      if (text.length > 100000) text = text.substring(0, 100000) + '...'
      return `Unit/Topic: ${t.title}\nContent:\n${text}`
    })
    .join('\n\n')

  if (profile.calibrationModule && topicData.week === profile.calibrationModule) {
    const combinedText = localStyleExercises.map((ex) => ex.questionText).join(' ')
    const results = await searchTopics(topicData.courseId, combinedText, { excludeWeeks: [profile.calibrationModule] })
    const globalContext = formatSearchResults(results)
    if (globalContext) {
      bucketContext = `${bucketContext}\n\n=========================================\n\nADDITIONAL GROUNDING CONTEXT FROM PRECEDING LECTURES/SLIDES:\n\n${globalContext}`
    }
  }

  return bucketContext
}

/**
 * Generates and stores one exercise for a topic. Does not touch sessions.
 * Returns null when the primary topic does not exist; model and database errors propagate.
 *
 * `styleTopicIds` (default `poolTopicIds`) is the fallback list for style examples; the study interface passes
 * the whole session topic list there while the grounding pool may be narrower.
 */
export async function generateExerciseForTopic(args: {
  primaryTopicId: string
  poolTopicIds: string[]
  existingExerciseIds: string[]
  styleTopicIds?: string[]
}): Promise<(Exercise & { topic: Topic }) | null> {
  const { primaryTopicId, poolTopicIds, existingExerciseIds } = args
  const topicData = await prisma.topic.findUnique({ where: { id: primaryTopicId } })
  if (!topicData) return null

  const existingExercisesInSession = await prisma.exercise.findMany({
    where: { id: { in: existingExerciseIds } },
    select: { topicId: true, questionText: true },
  })

  const course = await getCourseWithProfile(topicData.courseId)
  const profile = course?.profile ?? LEGACY_VOICE_PROFILE

  // Style examples from the target topic's module (previously generated ones included)
  const existingExercises = await fetchLocalStyleExamples(topicData, args.styleTopicIds ?? poolTopicIds, existingExerciseIds)
  const existingExercisesContext = existingExercises.map(describeExercise).join('\n\n')

  const targetType = pickQuestionType(profile, topicData.isQuantitative, existingExerciseIds.length)

  // Grounding bucket: pool topics that share the target topic's module
  const sameWeekTopics = await prisma.topic.findMany({
    where: { courseId: topicData.courseId, week: topicData.week },
  })
  const sameWeekTopicIdSet = new Set(sameWeekTopics.map((t) => t.id))
  const bucketTopicIds = poolTopicIds.filter((id) => sameWeekTopicIdSet.has(id))
  if (bucketTopicIds.length === 0) bucketTopicIds.push(primaryTopicId)

  const bucketTopics = await prisma.topic.findMany({ where: { id: { in: bucketTopicIds } } })
  const bucketContext = await compileGroundingContext(topicData, bucketTopics, existingExercises, profile)
  const rigorExercisesContext = await fetchRigorExamples(topicData.courseId, profile)

  const alreadyAskedQuestionsText = existingExercisesInSession
    .map((ex, idx) => `Question ${idx + 1}: ${ex.questionText}`)
    .join('\n\n')

  const { object } = await generateObject({
    model: textModel(),
    prompt: generateExercisePrompt(profile, {
      topic: { title: topicData.title, week: topicData.week, isQuantitative: topicData.isQuantitative },
      courseCode: course?.code,
      bucketContext,
      rigorExamples: rigorExercisesContext,
      styleExamples: existingExercisesContext,
      alreadyAsked: alreadyAskedQuestionsText,
      targetType,
    }),
    schema: z.object({
      newExercise: z.object({
        questionText: z.string(),
        exerciseType: z.enum(['single_choice', 'multiple_choice', 'numeric', 'dropdown']),
        choices: z.array(z.string()),
        correctAnswer: z.string(),
        explanation: z.string(),
      }),
    }),
  })

  const genEx = object.newExercise

  // Randomize choices to remove the model's position bias
  let finalChoices = genEx.choices
  if (genEx.exerciseType === 'single_choice' || genEx.exerciseType === 'multiple_choice' || genEx.exerciseType === 'dropdown') {
    finalChoices = shuffleArray(genEx.choices)
  }

  return prisma.exercise.create({
    data: {
      id: `gen-${crypto.randomUUID()}`,
      topicId: primaryTopicId,
      questionText: genEx.questionText,
      exerciseType: genEx.exerciseType,
      choices: JSON.stringify(finalChoices),
      correctAnswer: genEx.correctAnswer,
      explanation: genEx.explanation,
    },
    include: { topic: true },
  })
}
