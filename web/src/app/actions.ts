'use server'

import { generateText, generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { prisma } from '@/lib/db'
import { createSessionSummary } from '@/services/summaryService'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'

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
      model: google('gemini-3.6-flash'), // You can also use gemini-2.0-flash
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

export async function getPreviousLectureTranscripts(courseId: string, currentClassName: string): Promise<string | null> {
  try {
    const course = await prisma.course.findUnique({
      where: { id: courseId }
    });
    if (!course) return null;

    const courseCode = course.code;
    const outlinePath = path.join(process.cwd(), '..', 'MIT_Learn_Courses', `${courseCode}_outline.json`);
    
    if (!fs.existsSync(outlinePath)) return null;

    const outline = JSON.parse(fs.readFileSync(outlinePath, 'utf8'));

    // Find the section and index of the current class
    let targetSection: any = null;
    let currentLinkIndex = -1;

    for (const section of outline) {
      const idx = section.links.findIndex((l: any) => l.text === currentClassName);
      if (idx !== -1) {
        targetSection = section;
        currentLinkIndex = idx;
        break;
      }
    }

    if (!targetSection || currentLinkIndex === -1) return null;

    // Search backwards for the first preceding class that contains a transcript in the DB
    for (let i = currentLinkIndex - 1; i >= 0; i--) {
      const precedingClassName = targetSection.links[i].text;
      
      // Fetch any Transcript topics under this class
      const transcripts = await prisma.topic.findMany({
        where: {
          courseId,
          className: precedingClassName,
          resourceType: 'Transcript .txt'
        }
      });

      if (transcripts.length > 0) {
        const transcriptText = transcripts
          .map(t => `Topic: ${t.title}\nTranscript:\n${t.content || ''}`)
          .join('\n\n');
        
        if (transcriptText.trim().length > 50) {
          return transcriptText;
        }
      }
    }
  } catch (error) {
    console.error("Error fetching previous lecture transcripts:", error);
  }
  return null;
}

export async function needsContextEnrichment(text: string): Promise<boolean> {
  return !text.includes('<!-- enriched -->');
}

export async function enrichExerciseWithContext(exercise: any) {
  try {
    const topicData = exercise.topic;
    if (!topicData) return exercise;

    // Fetch preceding lecture transcript context if it exists
    const lectureTranscripts = await getPreviousLectureTranscripts(topicData.courseId, topicData.className);

    // If no preceding lecture transcript is found, fallback to surrounding week topics
    let contextText = lectureTranscripts;
    if (!contextText) {
      const contextTopics = await prisma.topic.findMany({
        where: {
          courseId: topicData.courseId,
          week: topicData.week
        }
      });
      contextText = contextTopics.map(t => {
        let text = t.content || '';
        if (text.length > 100000) {
          text = text.slice(0, 100000) + '... [TRUNCATED]';
        }
        return `Topic: ${t.title}\nContent:\n${text}`;
      }).join('\n\n');
    }

    let parsedChoices: string[] = [];
    try {
      if (exercise.choices) {
        parsedChoices = typeof exercise.choices === 'string' ? JSON.parse(exercise.choices) : exercise.choices;
      }
    } catch (e) {}

    const prompt = `You are an expert curriculum developer and professor at MIT.
We have a question from an MIT MicroMasters course that was extracted directly from a sequential series of exercises.
Because it is played standalone in a flashcard interface, some questions might lack context because they refer to specific research papers, case studies, concrete programs/policies (e.g., the Balsakhi program, the GoBifo study, the Extra Teacher Program), figures, or lecture experiments.

Your task is to review the question and decide if it actually needs context, and then re-generate it accordingly.

Lecture Transcripts / Lesson Context:
${contextText}

Original Question Text:
${exercise.questionText}

Exercise Type: ${exercise.exerciseType}
Choices/Options:
${parsedChoices.map(c => `- ${c}`).join('\n')}
Correct Answer: ${exercise.correctAnswer}

Instructions & Constraints:

1. CRITICAL: AVOID ADDING UNNECESSARY CONTEXT OR CONCEPTUAL THEORY:
   - If the question is a general, purely theoretical, or conceptual question (e.g., "In a cluster randomized evaluation, doubling the sample size will...", "What is statistical power?", or general math/statistics/economics questions), it is already fully self-contained!
   - For general theoretical/conceptual questions, do NOT add generic textbook preambles, and do NOT explain the theory. You must return the original question text exactly as is (do not summarize, explain, or prepend any generic textbook theory).
   - ONLY enrich the question if it refers to a concrete, specific real-world case study, a particular research paper/author, a specific program/policy, a specific dataset, or a particular experiment from the lectures that is missing its setup context.

2. NEUTRALITY & NO HINTS:
   - The re-generated text MUST NOT be biased, leading, or hint at the correct answer in any way! It must remain completely neutral and objective.
   - Do NOT contain, define, explain, or suggest the correct answer, nor rule out any of the incorrect options.

3. CONTEXT INTEGRATION (When needed):
   - When the question refers to a concrete study/paper/case study (e.g., "Balsakhi program", "GoBifo"), ONLY append the necessary, specific setup details of that program, paper, or research scenario from the lecture transcripts.
   - Do NOT add a generic textbook lecture summary. Only describe the concrete program/paper setup itself.
   - Keep the underlying logic, question, options/choices, and correct answer exactly the same.
   - Remove relative references like "above", "in the video", "in the lecture" and replace them with the concrete name of the program, policy, or dataset being discussed.
   - Ensure the resulting question text is clear, professional, and directly answerable.

Respond with a JSON object that contains the re-generated question text.

JSON Schema:
{
  "enrichedQuestionText": string
}
`;

    const { object } = await generateObject({
      model: google('gemini-3.6-flash'),
      schema: z.object({
        enrichedQuestionText: z.string()
      }),
      prompt
    });

    if (object?.enrichedQuestionText) {
      const enrichedText = `<!-- enriched -->\n${object.enrichedQuestionText}`;
      
      // Persist in DB so we never have to do this again for this exercise
      await prisma.exercise.update({
        where: { id: exercise.id },
        data: { questionText: enrichedText }
      });

      return {
        ...exercise,
        questionText: enrichedText
      };
    }
  } catch (error) {
    console.error(`Failed to enrich exercise ${exercise.id} with context:`, error);
  }
  return exercise;
}

export async function createStudySession(topicIds: string[], count: number) {
  let selected: any[] = []
  let missingCount = 0;

  if (topicIds.length > 0) {
    const exercises = await prisma.exercise.findMany({
      where: { topicId: { in: topicIds } },
      include: { topic: true }
    })
    
    // Group exercises by topicId
    const groups: Record<string, any[]> = {};
    for (const id of topicIds) {
      groups[id] = [];
    }
    for (const ex of exercises) {
      if (groups[ex.topicId] !== undefined) {
        groups[ex.topicId].push(ex);
      }
    }

    // Shuffle the exercises within each topic group individually
    for (const id of topicIds) {
      const group = groups[id];
      if (group) {
        for (let i = group.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [group[i], group[j]] = [group[j], group[i]];
        }
      }
    }

    // Round-robin select from each topic group until we reach maxExistingToKeep
    const maxExistingToKeep = Math.floor(count / 2);
    const targetCount = Math.min(exercises.length, maxExistingToKeep);
    const selectedExercises: any[] = [];
    
    // Shuffle the topic IDs so the starting order of topics in round-robin is randomized (crucial when T > G)
    const shuffledTopicIds = [...topicIds];
    for (let i = shuffledTopicIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledTopicIds[i], shuffledTopicIds[j]] = [shuffledTopicIds[j], shuffledTopicIds[i]];
    }

    let added = true;
    while (selectedExercises.length < targetCount && added) {
      added = false;
      for (const id of shuffledTopicIds) {
        if (selectedExercises.length >= targetCount) break;
        const group = groups[id];
        if (group && group.length > 0) {
          selectedExercises.push(group.pop());
          added = true;
        }
      }
    }

    selected = selectedExercises;
    missingCount = count - selected.length;
  } else {
    // Random selection across all topics with round-robin distribution to prevent crowding
    const exercises = await prisma.exercise.findMany({
      include: { topic: true }
    })
    
    const uniqueTopicIds = Array.from(new Set(exercises.map(e => e.topicId).filter(Boolean)));

    // Group exercises by topicId
    const groups: Record<string, any[]> = {};
    for (const id of uniqueTopicIds) {
      groups[id] = [];
    }
    for (const ex of exercises) {
      if (ex.topicId && groups[ex.topicId] !== undefined) {
        groups[ex.topicId].push(ex);
      }
    }

    // Shuffle the exercises within each topic group individually
    for (const id of uniqueTopicIds) {
      const group = groups[id];
      if (group) {
        for (let i = group.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [group[i], group[j]] = [group[j], group[i]];
        }
      }
    }

    // Round-robin select
    const targetCount = Math.min(exercises.length, count);
    const selectedExercises: any[] = [];
    
    // Shuffle the unique topic IDs so the starting order of topics in round-robin is randomized
    const shuffledTopicIds = [...uniqueTopicIds];
    for (let i = shuffledTopicIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledTopicIds[i], shuffledTopicIds[j]] = [shuffledTopicIds[j], shuffledTopicIds[i]];
    }

    let added = true;
    while (selectedExercises.length < targetCount && added) {
      added = false;
      for (const id of shuffledTopicIds) {
        if (selectedExercises.length >= targetCount) break;
        const group = groups[id];
        if (group && group.length > 0) {
          selectedExercises.push(group.pop());
          added = true;
        }
      }
    }

    selected = selectedExercises;
  }

  // Enrich selected exercises that need context
  selected = await Promise.all(selected.map(async (ex) => {
    if (await needsContextEnrichment(ex.questionText)) {
      return enrichExerciseWithContext(ex);
    }
    return ex;
  }));

  // Determine a descriptive title based on selected courses and weeks
  let sessionTitle = "Random Study Session";
  if (topicIds.length > 0) {
    const selectedTopicsData = await prisma.topic.findMany({
      where: { id: { in: topicIds } },
      include: { course: true }
    });
    
    const courseCodes = Array.from(new Set(selectedTopicsData.map(t => t.course?.code).filter(Boolean)));
    const weeks = Array.from(new Set(selectedTopicsData.map(t => {
      const w = t.week || "";
      const match = w.match(/Week_(\d+)/i) || w.match(/Week\s*(\d+)/i);
      if (match) {
        return `Week ${parseInt(match[1])}`;
      }
      return w.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    }).filter(Boolean)));

    if (courseCodes.length > 0 && weeks.length > 0) {
      sessionTitle = `${courseCodes.join(', ')} - ${weeks.join(', ')}`;
    } else if (courseCodes.length > 0) {
      sessionTitle = `${courseCodes.join(', ')} Study Session`;
    } else if (weeks.length > 0) {
      sessionTitle = `${weeks.join(', ')} Study Session`;
    }
  }

  const session = await prisma.studySession.create({
    data: {
      status: 'active',
      title: sessionTitle,
      exerciseIds: JSON.stringify(selected.map((e: any) => e.id))
    },
    include: { logs: true }
  })

  return { session, exercises: selected, missingCount }
}

export async function logAnswer(sessionId: string, exerciseId: string, isCorrect: boolean, duration: number, userAnswer?: string) {
  try {
    await prisma.exerciseLog.create({
      data: {
        sessionId,
        exerciseId,
        isCorrect,
        userAnswer,
        duration
      }
    })
  } catch (error: any) {
    console.error("Failed to log answer (likely stale session):", error.message)
  }
}

export async function saveChatLog(sessionId: string, messages: any[]) {
  try {
    await prisma.studySession.update({
      where: { id: sessionId },
      data: { chatLog: JSON.stringify(messages) }
    })
  } catch (error: any) {
    console.error("Failed to save chat log (likely stale session):", error.message)
  }
}

export async function getSessionHistory() {
  return prisma.studySession.findMany({
    orderBy: { startTime: 'desc' },
    take: 10,
    include: { logs: { include: { exercise: true } } }
  })
}

export async function getClassContextForTopic(topicId: string) {
  const topic = await prisma.topic.findUnique({ where: { id: topicId } })
  if (!topic || !topic.className) return null
  
  const classTopics = await prisma.topic.findMany({
    where: {
      courseId: topic.courseId,
      week: topic.week,
      className: topic.className
    }
  })
  
  return classTopics.map(t => ({
    title: t.title,
    content: t.content,
    localPath: t.localPath
  }))
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

export async function getAnalyticsData() {
  const sessions = await prisma.studySession.findMany({
    include: { logs: { include: { exercise: { include: { topic: { include: { course: true } } } } } } }
  });

  const totalSessions = sessions.length;
  let totalExercises = 0;
  let totalCorrect = 0;

  const courseStats: Record<string, { total: number, correct: number }> = {};
  const heatmapStats: Record<string, Record<string, { total: number, correct: number, classes: Record<string, any> }>> = {};

  // Last 7 days activity (by date)
  const activityByDate: Record<string, number> = {};
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    activityByDate[d.toISOString().split('T')[0]] = 0;
  }

  sessions.forEach(session => {
    const dateStr = new Date(session.startTime).toISOString().split('T')[0];
    if (activityByDate[dateStr] !== undefined) {
      activityByDate[dateStr] += 1;
    }

    session.logs.forEach(log => {
      if (log.userAnswer === null || log.userAnswer === undefined || log.userAnswer === '') return;

      totalExercises++;
      if (log.isCorrect) totalCorrect++;

      const courseCode = log.exercise?.topic?.course?.code || 'Unknown';
      const week = log.exercise?.topic?.week || 'Unknown';
      const className = log.exercise?.topic?.className || 'Unknown Class';
      const unit = log.exercise?.topic?.unit || '';
      const subtopicTitle = log.exercise?.topic?.title || 'Unknown Subtopic';

      if (!courseStats[courseCode]) {
        courseStats[courseCode] = { total: 0, correct: 0 };
      }
      courseStats[courseCode].total++;
      if (log.isCorrect) courseStats[courseCode].correct++;

      if (!heatmapStats[courseCode]) {
        heatmapStats[courseCode] = {};
      }
      if (!heatmapStats[courseCode][week]) {
        heatmapStats[courseCode][week] = { total: 0, correct: 0, classes: {} };
      }
      heatmapStats[courseCode][week].total++;
      if (log.isCorrect) heatmapStats[courseCode][week].correct++;

      // Nest class/subtopic details
      const classKey = className;
      if (!heatmapStats[courseCode][week].classes[classKey]) {
        heatmapStats[courseCode][week].classes[classKey] = {
          className,
          total: 0,
          correct: 0,
          subtopics: {}
        };
      }
      heatmapStats[courseCode][week].classes[classKey].total++;
      if (log.isCorrect) heatmapStats[courseCode][week].classes[classKey].correct++;

      const subtopicKey = `${unit ? `Unit ${unit}: ` : ''}${subtopicTitle}`;
      if (!heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey]) {
        heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey] = {
          unit,
          title: subtopicTitle,
          total: 0,
          correct: 0
        };
      }
      heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey].total++;
      if (log.isCorrect) heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey].correct++;
    });
  });

  const courseAccuracy = Object.entries(courseStats).map(([name, stats]) => ({
    name,
    accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
    total: stats.total
  }));

  const activityChartData = Object.entries(activityByDate).map(([date, count]) => ({
    date,
    sessions: count
  }));

  const heatmapData = Object.entries(heatmapStats).map(([course, weeksMap]) => {
    const weeks = Object.entries(weeksMap).map(([week, stats]) => {
      const classes = Object.values(stats.classes).map((cl: any) => {
        const subtopics = Object.values(cl.subtopics).map((sub: any) => ({
          unit: sub.unit,
          title: sub.title,
          accuracy: sub.total > 0 ? Math.round((sub.correct / sub.total) * 100) : 0,
          total: sub.total,
          correct: sub.correct
        }));
        
        return {
          className: cl.className,
          accuracy: cl.total > 0 ? Math.round((cl.correct / cl.total) * 100) : 0,
          total: cl.total,
          correct: cl.correct,
          subtopics
        };
      });

      return {
        week,
        accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
        total: stats.total,
        classes
      };
    });
    return { course, weeks };
  });

  return {
    totalSessions,
    totalExercises,
    overallAccuracy: totalExercises > 0 ? Math.round((totalCorrect / totalExercises) * 100) : 0,
    courseAccuracy,
    activityChartData,
    heatmapData
  };
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export async function generateNextExercise(sessionId: string, topicIds: string[], existingExerciseIds: string[], missingCount: number = 1) {
  if (topicIds.length === 0) return null;

  // Find current representation of selected topics in the session to ensure proportional balance
  const existingExercisesInSession = await prisma.exercise.findMany({
    where: { id: { in: existingExerciseIds } },
    select: { topicId: true, questionText: true }
  });

  const representedTopicIds = new Set(existingExercisesInSession.map(ex => ex.topicId));
  const uncoveredTopicIds = topicIds.filter(id => !representedTopicIds.has(id));

  // If all selected topics are already represented, fallback to the full list of topicIds
  const targetPool = uncoveredTopicIds.length > 0 ? uncoveredTopicIds : topicIds;

  // Shuffle targetPool to randomize starting order and eliminate alphabetical or week-sorting bias in selection
  const shuffledTargetPool = [...targetPool];
  for (let i = shuffledTargetPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledTargetPool[i], shuffledTargetPool[j]] = [shuffledTargetPool[j], shuffledTargetPool[i]];
  }

  // Calculate bucket size to divide the remaining pool proportionally among remaining questions
  const qRemaining = missingCount > 0 ? missingCount : 1;
  const bucketSize = Math.ceil(shuffledTargetPool.length / qRemaining);

  // Take the first slice of the pool as the bucket for this question
  const bucketTopicIds = shuffledTargetPool.slice(0, bucketSize);
  const primaryTopicId = bucketTopicIds[0];

  const topicData = await prisma.topic.findUnique({ where: { id: primaryTopicId } });
  
  if (!topicData) return null;

  const contextTopics = await prisma.topic.findMany({
    where: { 
      courseId: topicData.courseId,
      week: topicData.week 
    }
  });

  const topicsContext = contextTopics.map(t => {
    let text = t.content || '';
    if (text.length > 100000) text = text.substring(0, 100000) + '...';
    return `Title: ${t.title}\nContent Summary:\n${text}`;
  }).join('\n\n');

  // Fetch and format content for all topics in this bucket
  const bucketTopics = await prisma.topic.findMany({
    where: { id: { in: bucketTopicIds } }
  });

  const bucketContext = bucketTopics.map(t => {
    let text = t.content || '';
    if (text.length > 100000) text = text.substring(0, 100000) + '...';
    return `Unit/Topic: ${t.title}\nContent:\n${text}`;
  }).join('\n\n');

  // Format existing questions in the active session for Gemini's deduplication context
  const alreadyAskedQuestionsText = existingExercisesInSession
    .map((ex, idx) => `Question ${idx + 1}: ${ex.questionText}`)
    .join('\n\n');

  // Fetch a few existing exercises to provide style context, excluding the ones already in the session
  const existingExercises = await prisma.exercise.findMany({
    where: { topicId: { in: topicIds }, id: { notIn: existingExerciseIds } },
    take: 5
  });

  const existingExercisesContext = existingExercises.map(ex => {
    return `Type: ${ex.exerciseType}\nQuestion: ${ex.questionText}\nChoices: ${ex.choices}\nCorrect Answer: ${ex.correctAnswer}`;
  }).join('\n\n');

  try {
    const { object } = await generateObject({
      model: google('gemini-3.6-flash'),
      prompt: `You are an MIT economics professor.
Your goal is to generate EXACTLY 1 NEW exercise for an MIT economics course based SPECIFICALLY on the following target topic(s):

${bucketContext}

Here are some examples of existing questions to match the style and difficulty (do NOT copy their topic, focus ONLY on the Target Topic(s) above):
${existingExercisesContext}

Here are the questions that are ALREADY present in the student's active study session. You MUST NOT repeat, duplicate, or ask about the exact same concepts or scenarios tested in these questions:
${alreadyAskedQuestionsText || "No questions have been asked yet in this session."}

CRITICAL DEDUPLICATION RULES:
1. Review the "ALREADY present" questions listed above. Your newly generated question MUST NOT test the same concept, use the same core scenario, or ask the same question as any of them. It must be completely distinct and test a different concept or scenario from the Target Topic(s) listed above: ${bucketTopics.map(t => `"${t.title}"`).join(', ')}.
2. The new question MUST be about the concepts described in the Target Topic(s) listed above. Do NOT generate questions about other topics in the surrounding context or style examples.
3. Ensure that the question covers a concept or uses a scenario from the Target Topic(s). Every question MUST be completely self-contained (invent hypothetical scenarios or markdown data tables if a concept requires it).

CRITICAL GROUNDING AND TRUTHFULNESS RULES:
1. STRICT GROUNDING: The generated question, choices, correct answer, and official explanation MUST be 100% strictly grounded in and derived from the provided Target Topic content above.
2. NO EXTERNAL TERMS: You MUST NOT introduce or test any external concepts, acronyms, economic terms, or advanced terminology that are not explicitly defined, mentioned, or discussed in the provided Target Topic Content.
3. NO EXTRAPOLATIONS: Do not assume the student knows prerequisite or external context that is not directly present in the provided lecture notes/transcript. If a term is not in the provided text, you must not use or refer to it.
4. SELF-CONTAINED SCENARIOS: You may create hypothetical research scenarios or data tables to illustrate a concept, but any such scenario or table MUST strictly test the principles directly covered in the provided Content, without introducing outside academic or statistical definitions.

Generate ONE of the following types for the new question:
- "single_choice": Standard multiple choice (one correct answer).
- "multiple_choice": Multiple correct answers. 'choices' should contain the options. 'correctAnswer' must be a JSON array of the correct choices.
- "numeric": A question requiring a numerical answer. 'choices' should be an empty array []. 'correctAnswer' should be the numeric value as a string.
- "dropdown": Fill in the blank sentence. 'questionText' should include exactly one [BLANK] placeholder. 'choices' should be an array of possible words to fill the blank. 'correctAnswer' should be the correct word.`,
      schema: z.object({
        newExercise: z.object({
          questionText: z.string(),
          exerciseType: z.enum(['single_choice', 'multiple_choice', 'numeric', 'dropdown']),
          choices: z.array(z.string()),
          correctAnswer: z.string(),
          explanation: z.string()
        })
      })
    });

    const genEx = object.newExercise;

    // Explicitly randomize choices to eliminate LLM position bias
    let finalChoices = genEx.choices;
    if (genEx.exerciseType === 'single_choice' || genEx.exerciseType === 'multiple_choice' || genEx.exerciseType === 'dropdown') {
      finalChoices = shuffleArray(genEx.choices);
    }

    const newEx = await prisma.exercise.create({
      data: {
        topicId: primaryTopicId,
        questionText: genEx.questionText,
        exerciseType: genEx.exerciseType,
        choices: JSON.stringify(finalChoices),
        correctAnswer: genEx.correctAnswer,
        explanation: genEx.explanation
      },
      include: { topic: true }
    });

    // Update session
    const session = await prisma.studySession.findUnique({ where: { id: sessionId } });
    if (session) {
      const currentIds = session.exerciseIds ? JSON.parse(session.exerciseIds) : [];
      await prisma.studySession.update({
        where: { id: sessionId },
        data: { exerciseIds: JSON.stringify([...currentIds, newEx.id]) }
      });
    }

    return newEx;
  } catch (e) {
    console.error("Failed to generate next exercise:", e);
    return null;
  }
}

export async function deleteStudySession(sessionId: string) {
  try {
    // Delete logs first to avoid foreign key constraint violations
    await prisma.exerciseLog.deleteMany({
      where: { sessionId }
    });
    // Delete session
    await prisma.studySession.delete({
      where: { id: sessionId }
    });
    return true;
  } catch (error) {
    console.error("Failed to delete study session:", error);
    return false;
  }
}

export async function generateSessionSummary(sessionId: string) {
  try {
    return await createSessionSummary(sessionId);
  } catch (error) {
    console.error('Error in generateSessionSummary action:', error)
    throw error
  }
}
