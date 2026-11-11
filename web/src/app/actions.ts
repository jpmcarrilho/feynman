'use server'

import { generateText, generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { prisma } from '@/lib/db'
import { createSessionSummary } from '@/services/summaryService'
import { getCourseArtifactsService, generateWeekSummaryService } from '@/services/artifactsService'
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

export async function getGlobalCourseContext(courseId: string, text: string): Promise<string> {
  const academicKeywords = [
    "ferraz", "finan", "olken", "jones", "acemoglu", "robinson", "johnson", "nichter", "larreguy", 
    "hsieh", "chavez", "marshall", "trucco", "nunn", "wantchekon", "fujiwara", "duflo", "banerjee", 
    "kremer", "miguel", "glewwe", "balsakhi", "gobifo", "deworming", "mita", "maisanta", "audits", 
    "corruption", "weigh station", "checkpoints", "re-election", "property rights", "titling", 
    "vote-buying", "turnout buying", "media", "social media", "reciprocity", "trust game", "jonesolken", 
    "ajr", "dell", "maternal", "coercion", "intimidation", "clientelism"
  ];

  const matchedKeywords: string[] = [];
  const lowercaseText = text.toLowerCase();
  for (const keyword of academicKeywords) {
    if (lowercaseText.includes(keyword)) {
      matchedKeywords.push(keyword);
    }
  }

  if (matchedKeywords.length === 0) return "";

  // Query topics in the database that match these keywords in their title or content
  const orConditions = matchedKeywords.flatMap(kw => [
    { title: { contains: kw } },
    { content: { contains: kw } }
  ]);

  const matchedTopics = await prisma.topic.findMany({
    where: {
      courseId,
      OR: orConditions,
      NOT: [
        { week: { contains: "comprehensive_review" } },
        { week: { contains: "comprehensive review" } }
      ]
    },
    select: { title: true, content: true, week: true, resourceType: true },
    take: 10
  });

  const formattedContext = matchedTopics.map(t => {
    let contentText = t.content || '';
    if (contentText.length > 50000) {
      contentText = contentText.slice(0, 50000) + '... [TRUNCATED]';
    }
    return `[Source: ${t.week} - ${t.title} (${t.resourceType})]\n${contentText}`;
  }).join('\n\n=========================================\n\n');

  return formattedContext;
}

export async function getGlobalCourseContextForExercises(courseId: string, exercises: any[]): Promise<string> {
  const combinedText = exercises.map(ex => ex.questionText).join(' ');
  return getGlobalCourseContext(courseId, combinedText);
}

export async function needsContextEnrichment(text: string): Promise<boolean> {
  const lowercase = text.toLowerCase();
  if (text.includes('<!-- enriched -->')) {
    // If previous enrichment failed to provide table details (no markdown table | present)
    if (lowercase.includes('table') && !text.includes('|')) {
      return true;
    }
    return false;
  }
  return true;
}

export async function enrichExerciseWithContext(exercise: any) {
  try {
    const topicData = exercise.topic;
    if (!topicData) return exercise;

    // 1. Fetch preceding lecture transcript context if it exists (highest local fidelity)
    let contextText = await getPreviousLectureTranscripts(topicData.courseId, topicData.className);

    // 2. If no preceding lecture transcript is found, fallback to global course-wide keyword search
    if (!contextText) {
      contextText = await getGlobalCourseContext(topicData.courseId, exercise.questionText);
    }

    // 3. Fallback to surrounding week topics
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

2. RECONSTRUCT MISSING TABLES & DATA:
   - If the original question refers to a Table (e.g., "Table 1", "Table 2", "according to the table") or a set of regression estimates, and the provided Lesson Context contains those estimates, values, or regression coefficients, you MUST reconstruct that table as a beautiful, clean Markdown table directly inside the enriched question text!
   - Ensure all column headers and values are accurate based on the context. If the exact table isn't in the context, but the values are described, construct a parallel simplified representation.

3. NEUTRALITY & NO HINTS:
   - The re-generated text MUST NOT be biased, leading, or hint at the correct answer in any way! It must remain completely neutral and objective.
   - Do NOT contain, define, explain, or suggest the correct answer, nor rule out any of the incorrect options.

4. CONTEXT INTEGRATION (When needed):
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

export async function createStudySession(
  topicIds: string[], 
  count: number, 
  mode: 'study' | 'exam' = 'study', 
  timeLimit: number | null = null, 
  sourcingMix: number = 50,
  weakPct: number = 60,
  unstudiedPct: number = 20,
  expertPct: number = 20
) {
  let selected: any[] = []
  let missingCount = 0;

  // Check if we are selecting from a comprehensive review topic
  let isComprehensiveReview = false;
  let comprehensiveCourseId: string | null = null;
  if (topicIds.length > 0) {
    const selectedTopicsData = await prisma.topic.findMany({
      where: { id: { in: topicIds } }
    });
    isComprehensiveReview = selectedTopicsData.some(t => 
      t.week?.toLowerCase().includes('comprehensive_review') || 
      t.week?.toLowerCase().includes('comprehensive review')
    );
    if (isComprehensiveReview && selectedTopicsData.length > 0) {
      comprehensiveCourseId = selectedTopicsData[0].courseId;
    }
  }

  // Determine maximum existing questions to keep based on the selected sourcing mix ratio
  const aiRatio = sourcingMix / 100;
  const maxExistingRatio = 1.0 - aiRatio;
  const maxExistingToKeep = Math.floor(count * maxExistingRatio);

  // Fetch candidate exercises
  let candidateExercises: any[] = [];
  if (topicIds.length > 0) {
    if (isComprehensiveReview && comprehensiveCourseId) {
      // For a comprehensive review session, automatically expand the candidate pool 
      // to include ALL exercises from the entire course to prevent clustered, repetitive questions!
      candidateExercises = await prisma.exercise.findMany({
        where: { topic: { courseId: comprehensiveCourseId } },
        include: { topic: true }
      });
    } else {
      candidateExercises = await prisma.exercise.findMany({
        where: { topicId: { in: topicIds } },
        include: { topic: true }
      });
    }
  } else {
    candidateExercises = await prisma.exercise.findMany({
      include: { topic: true }
    });
  }

  // Filter out any surveys, feedback forms, or ungraded discussion/demographic questions
  candidateExercises = candidateExercises.filter(ex => {
    const qText = ex.questionText.toLowerCase();
    const tTitle = (ex.topic?.title || "").toLowerCase();
    const isSurvey = 
      qText.includes("survey") || 
      qText.includes("ungraded") || 
      qText.includes("feedback") || 
      qText.includes("time spent") || 
      qText.includes("hours per week") || 
      qText.includes("how many hours did you spend") ||
      tTitle.includes("survey") || 
      tTitle.includes("ungraded") || 
      tTitle.includes("required participation") ||
      tTitle.includes("feedback");
    return !isSurvey;
  });

  if (candidateExercises.length > 0) {
    // 1. Fetch user accuracy and coverage stats per exercise to group candidates individually
    const logs = await prisma.exerciseLog.findMany({
      select: { exerciseId: true, isCorrect: true }
    });

    // 2. Separate candidate exercises into Expert, Worst, and Unstudied pools based on individual performance logs
    const expertPool: any[] = [];
    const worstPool: any[] = [];
    const unstudiedPool: any[] = [];

    for (const ex of candidateExercises) {
      const exerciseLogs = logs.filter(l => l.exerciseId === ex.id);

      if (exerciseLogs.length === 0) {
        unstudiedPool.push(ex);
      } else {
        const correctCount = exerciseLogs.filter(l => l.isCorrect).length;
        const accuracy = (correctCount / exerciseLogs.length) * 100;
        if (accuracy >= 70) {
          expertPool.push(ex);
        } else {
          worstPool.push(ex);
        }
      }
    }

    // Shuffle each pool individually to ensure maximum random retrieval within criteria
    const shuffle = (arr: any[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    };
    shuffle(expertPool);
    shuffle(worstPool);
    shuffle(unstudiedPool);

    // 3. Compute target counts based on the custom proportions selected by the user
    const targetCount = Math.min(candidateExercises.length, maxExistingToKeep);
    
    // Normalize percentages to make sure they sum to 100%
    const totalPct = (weakPct + unstudiedPct + expertPct) || 100;
    const wRatio = weakPct / totalPct;
    const uRatio = unstudiedPct / totalPct;
    const eRatio = expertPct / totalPct;

    let targetWorst = Math.round(targetCount * wRatio);
    let targetUnstudied = Math.round(targetCount * uRatio);
    let targetExpert = Math.round(targetCount * eRatio);

    // Safeguard totals to equal exactly targetCount
    const diff = targetCount - (targetWorst + targetUnstudied + targetExpert);
    if (diff !== 0) {
      targetWorst += diff;
    }

    const selectedExercises: any[] = [];

    // Pull from each pool up to the targets
    const pullWorst = worstPool.slice(0, targetWorst);
    const pullUnstudied = unstudiedPool.slice(0, targetUnstudied);
    const pullExpert = expertPool.slice(0, targetExpert);

    selectedExercises.push(...pullWorst, ...pullUnstudied, ...pullExpert);

    // 4. Fallback/Fill Mechanism: if a pool was too small, fill remainder from remaining pools
    if (selectedExercises.length < targetCount) {
      const remainingCandidates = candidateExercises.filter(ex => 
        !selectedExercises.some(se => se.id === ex.id)
      );
      shuffle(remainingCandidates);
      const needed = targetCount - selectedExercises.length;
      selectedExercises.push(...remainingCandidates.slice(0, needed));
    }

    selected = selectedExercises;
    missingCount = count - selected.length;
  } else {
    selected = [];
    missingCount = count;
  }

  // Enrich selected exercises that need context
  selected = await Promise.all(selected.map(async (ex) => {
    // enrichedAt replaces the in-band marker (stripped by the studyspaces backfill)
    if (!ex.enrichedAt && await needsContextEnrichment(ex.questionText)) {
      return enrichExerciseWithContext(ex);
    }
    return ex;
  }));

  // Determine a descriptive title based on selected courses and weeks
  let sessionTitle = mode === 'exam' ? "Timed Exam Session" : "Random Study Session";
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

    const typePrefix = mode === 'exam' ? "Exam" : "Study";

    if (courseCodes.length > 0 && weeks.length > 0) {
      sessionTitle = `${courseCodes.join(', ')} - ${weeks.join(', ')} (${typePrefix})`;
    } else if (courseCodes.length > 0) {
      sessionTitle = `${courseCodes.join(', ')} ${typePrefix} Session`;
    } else if (weeks.length > 0) {
      sessionTitle = `${weeks.join(', ')} ${typePrefix} Session`;
    }
  }

  const session = await prisma.studySession.create({
    data: {
      status: 'active',
      title: sessionTitle,
      mode,
      timeLimit,
      sourcingMix,
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

export async function finishStudySession(sessionId: string) {
  try {
    return await prisma.studySession.update({
      where: { id: sessionId },
      data: { 
        status: 'completed',
        endTime: new Date()
      }
    })
  } catch (error: any) {
    console.error("Failed to finish study session:", error.message)
    return null
  }
}

export async function getSessionHistory() {
  return prisma.studySession.findMany({
    orderBy: { startTime: 'desc' },
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

  const completedExams = sessions
    .filter(s => s.mode === 'exam' && s.status === 'completed')
    .map(s => {
      const totalQs = s.logs.length;
      const correctQs = s.logs.filter(l => l.isCorrect).length;
      return {
        id: s.id,
        title: s.title || "Timed Exam",
        startTime: s.startTime,
        endTime: s.endTime,
        totalQuestions: totalQs,
        correctQuestions: correctQs,
        accuracy: totalQs > 0 ? Math.round((correctQs / totalQs) * 100) : 0,
        diagnosis: s.diagnosis
      };
    })
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  const globalSession = await prisma.studySession.findFirst({
    where: { mode: 'global_diagnosis' }
  });

  const evolutionData = await getTopicEvolutionData();

  return {
    totalSessions,
    totalExercises,
    overallAccuracy: totalExercises > 0 ? Math.round((totalCorrect / totalExercises) * 100) : 0,
    courseAccuracy,
    activityChartData,
    heatmapData,
    completedExams,
    globalDiagnosis: globalSession?.diagnosis || null,
    evolutionData
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

function determineTargetQuestionType(week: string | null, existingCount: number): 'single_choice' | 'multiple_choice' | 'numeric' | 'dropdown' {
  const isQuantitativeWeek = 
    week?.toLowerCase().includes('week_06') || 
    week?.toLowerCase().includes('week 6') || 
    week?.toLowerCase().includes('week_09') || 
    week?.toLowerCase().includes('week 9') || 
    week?.toLowerCase().includes('week_03') || 
    week?.toLowerCase().includes('week 3');

  if (isQuantitativeWeek) {
    // Quantitative weeks benefit heavily from numeric answers and multi-select formula proofs
    const quantTypes: Array<'numeric' | 'multiple_choice' | 'single_choice' | 'dropdown'> = [
      'numeric',
      'multiple_choice',
      'single_choice',
      'numeric',
      'multiple_choice',
      'dropdown'
    ];
    return quantTypes[existingCount % quantTypes.length];
  } else {
    // Qualitative/operational weeks should completely avoid numeric, relying on scenario case-studies and fill-ins
    const qualTypes: Array<'single_choice' | 'dropdown' | 'multiple_choice'> = [
      'single_choice',
      'dropdown',
      'single_choice',
      'multiple_choice',
      'dropdown'
    ];
    return qualTypes[existingCount % qualTypes.length];
  }
}

async function fetchRigorExamples(courseId: string): Promise<string> {
  // Find the Comprehensive Review topic under this course to get rigor style standards
  const compReviewTopics = await prisma.topic.findMany({
    where: {
      courseId,
      OR: [
        { week: { contains: "comprehensive_review" } },
        { week: { contains: "comprehensive review" } }
      ]
    },
    select: { id: true }
  });

  const compReviewTopicIds = compReviewTopics.map(t => t.id);
  
  let rigorExercises: any[] = [];
  if (compReviewTopicIds.length > 0) {
    rigorExercises = await prisma.exercise.findMany({
      where: { topicId: { in: compReviewTopicIds } },
      take: 3
    });
  }

  return rigorExercises.map(ex => {
    return `Type: ${ex.exerciseType}\nQuestion: ${ex.questionText}\nChoices: ${ex.choices}\nCorrect Answer: ${ex.correctAnswer}`;
  }).join('\n\n');
}

async function fetchLocalStyleExamples(topicData: any, topicIds: string[], existingIds: string[]): Promise<any[]> {
  // Fetch exercises from the same week in the database (including generated ones since user allowed them)
  let exercises = await prisma.exercise.findMany({
    where: { 
      topic: { week: topicData.week, courseId: topicData.courseId }, 
      id: { notIn: existingIds }
    },
    take: 5,
    include: { topic: true }
  });

  // Fallback to fetching from all selected topicIds if we don't have enough in this week
  if (exercises.length < 3) {
    const fallbackExercises = await prisma.exercise.findMany({
      where: { 
        topicId: { in: topicIds }, 
        id: { notIn: existingIds }
      },
      take: 5 - exercises.length,
      include: { topic: true }
    });
    exercises = [...exercises, ...fallbackExercises];
  }

  return exercises;
}

async function compileGroundingContext(topicData: any, bucketTopics: any[], localStyleExercises: any[]): Promise<string> {
  let bucketContext = bucketTopics.map(t => {
    let text = t.content || '';
    if (text.length > 100000) text = text.substring(0, 100000) + '...';
    return `Unit/Topic: ${t.title}\nContent:\n${text}`;
  }).join('\n\n');

  // For comprehensive reviews, fetch global course context matching papers/keywords in style examples
  const isCompReview = 
    topicData.week?.toLowerCase().includes('comprehensive_review') || 
    topicData.week?.toLowerCase().includes('comprehensive review');

  if (isCompReview) {
    const globalContext = await getGlobalCourseContextForExercises(topicData.courseId, localStyleExercises);
    if (globalContext) {
      bucketContext = `${bucketContext}\n\n=========================================\n\nADDITIONAL GROUNDING CONTEXT FROM PRECEDING LECTURES/SLIDES:\n\n${globalContext}`;
    }
  }

  return bucketContext;
}

export async function generateNextExercise(sessionId: string, topicIds: string[], existingExerciseIds: string[], missingCount: number = 1) {
  if (topicIds.length === 0) return null;

  try {
    // 1. Find current representation of selected topics in the session to ensure proportional balance
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

    // Identify primaryTopicId first
    const primaryTopicId = shuffledTargetPool[0];
    const topicData = await prisma.topic.findUnique({ where: { id: primaryTopicId } });
    if (!topicData) return null;

    // Fetch local style examples belonging to this target topic's week (can use previously generated ones)
    const existingExercises = await fetchLocalStyleExamples(topicData, topicIds, existingExerciseIds);
    const existingExercisesContext = existingExercises.map(ex => {
      return `Type: ${ex.exerciseType}\nQuestion: ${ex.questionText}\nChoices: ${ex.choices}\nCorrect Answer: ${ex.correctAnswer}`;
    }).join('\n\n');

    // 2. Determine target question type adaptively based on the week signature
    const targetType = determineTargetQuestionType(topicData.week, existingExerciseIds.length);

    // 3. To provide more context from the same week to enhance the question, we group topics of the same week
    const sameWeekTopics = await prisma.topic.findMany({
      where: { 
        courseId: topicData.courseId,
        week: topicData.week
      }
    });
    const sameWeekTopicIdSet = new Set(sameWeekTopics.map(t => t.id));
    
    // We filter targetPool for topics from the same week to form our grounding bucket
    const bucketTopicIds = targetPool.filter(id => sameWeekTopicIdSet.has(id));
    
    // If no same-week topics are in targetPool (unlikely), default to just the primary topic
    if (bucketTopicIds.length === 0) {
      bucketTopicIds.push(primaryTopicId);
    }

    const bucketTopics = await prisma.topic.findMany({
      where: { id: { in: bucketTopicIds } }
    });

    // 4. Compile core topic bucket context & global course-wide context
    const bucketContext = await compileGroundingContext(topicData, bucketTopics, existingExercises);

    // 5. Fetch Comprehensive Review style standards for difficulty/rigor calibration
    const rigorExercisesContext = await fetchRigorExamples(topicData.courseId);

    // 6. Format existing questions in the active session for Gemini's deduplication context
    const alreadyAskedQuestionsText = existingExercisesInSession
      .map((ex, idx) => `Question ${idx + 1}: ${ex.questionText}`)
      .join('\n\n');

    const { object } = await generateObject({
      model: google('gemini-3.6-flash'),
      prompt: `You are an MIT economics professor.
Your goal is to generate EXACTLY 1 NEW exercise for an MIT economics course. The question MUST test concepts and terminology specifically from the Target Topic: "${topicData.title}" in "${topicData.week}".

Here is the primary target content:
${bucketContext}

CRITICAL WEEK & TOPICS INTEGRITY RULE:
The generated question, its choices, correct answer, and explanation MUST be based directly on concepts from "${topicData.title}" (in "${topicData.week}"). You may use the other topics from "${topicData.week}" provided in the content for background enhancement, but you MUST NOT write a question about a different week or general topic.

CRITICAL DIFFICULTY & RIGOR CALIBRATION (MIT MicroMasters Final Exam Level):
The target question you generate must match the high analytical depth, multi-step logical reasoning, and mathematical complexity found on actual MIT final exams.
To calibrate this difficulty, review these "Comprehensive Review" example questions representing the true final-exam-level rigor and question length:
${rigorExercisesContext || "No specific comprehensive review style examples available."}

However, do NOT copy their topic. Your generated question MUST test concepts from the Target Topic "${topicData.title}", matching the style, formatting, and academic level of these local week style examples:
${existingExercisesContext}

CRITICAL: Do NOT copy the specific questions or concepts from the local week style examples listed above. Focus your question entirely on testing the concept of "${topicData.title}".

Here are the questions that are ALREADY present in the student's active study session. You MUST NOT repeat, duplicate, or ask about the exact same concepts or scenarios tested in these questions:
${alreadyAskedQuestionsText || "No questions have been asked yet in this session."}

CRITICAL DEDUPLICATION RULES:
1. Review the "ALREADY present" questions listed above. Your newly generated question MUST NOT test the same concept, use the same core scenario, or ask the same question as any of them. It must be completely distinct and test a different concept or scenario from the Target Topic: "${topicData.title}".
2. The new question MUST be about the concepts described in the Target Topic. Do NOT generate questions about other topics in the surrounding context or style examples.
3. Ensure that the question covers a concept or uses a scenario from the Target Topic. Every question MUST be completely self-contained (invent hypothetical scenarios or markdown data tables if a concept requires it).

CRITICAL VARIANT GENERATION RULES (VARIATION & RIGOR):
1. CONCEPTUAL PARALLELISM WITH VARIATION: Use the style examples in the database to generate a conceptually parallel but completely fresh exercise. Do NOT clone existing questions. Instead, adapt their core economic, statistical, or data collection principles into a new, original scenario.
2. VARY SCENARIOS, TITLES, & SETUPS: Change the titles of researchers, names of programs, policies, geographic locations, and experimental setups. If an existing question uses Olken's corruption study in Indonesia, your new question should describe a parallel hypothetical or actual evaluation in another context (e.g., an educational audit in India or construction in Kenya) to test the same underlying statistical principles.
3. VARY MATHEMATICAL & CALCULATION PARAMETERS: If the exercise requires any calculations (such as Wald estimates, standard errors, coefficients, utility functions, or regression equations), you MUST change the specific numeric variables, equations, or coefficients. The student should be forced to calculate a completely new result (do not repeat the numerical formulas, values, or options from the examples).
4. VARY THEORETICAL PERSPECTIVES & ANGLES: Look at the topic from another perspective or analytical angle. For example, if the existing question tests the "exclusion restriction" of an IV, your new question can test the "reduced form", "first stage strength", or discuss why "parallel trends" or "omitted variable bias" would fail in a similar model. If an existing question is from a citizen-candidate perspective, look at it from the voter's perspective, or modify the cost of entry parameter.

CRITICAL GROUNDING AND TRUTHFULNESS RULES:
1. STRICT GROUNDING: The generated question, choices, correct answer, and official explanation MUST be 100% strictly grounded in and derived from the provided Target Topic content above.
2. NO EXTERNAL TERMS: You MUST NOT introduce or test any external concepts, acronyms, economic terms, or advanced terminology that are not explicitly defined, mentioned, or discussed in the provided Target Topic Content.
3. NO EXTRAPOLATIONS: Do not assume the student knows prerequisite or external context that is not directly present in the provided lecture notes/transcript. If a term is not in the provided text, you must not use or refer to it.

CRITICAL SELF-CONTAINEDNESS MANDATE (NO OUTSIDE KNOWLEDGE ASSUMPTION):
1. MANDATORY CONTEXTUAL BACKGROUND: If your generated question mentions, tests, or refers to any specific research paper, author, academic study, historical event, or public policy (such as Acemoglu et al. 2001, Dell 2010, Olken 2007, Ferraz & Finan 2008, the Balsakhi program, or the Mita system), you MUST explicitly include a clear, 2-3 sentence introductory background summary of that study directly inside the question text itself.
2. BACKGROUND SETUP SPECIFICS: This summary must explain the study's primary setup (e.g., who/what was studied and where), the methodology used (e.g., differences-in-differences, RCT, or RD design), and any critical parameters.
3. LOGICAL ANSWERABILITY: Every question must be completely self-contained. A student who has never read the referenced paper or memorized its details must be able to understand the scenario and answer the question successfully purely by using logical reasoning, scientific principles, and the contextual details you have provided in the question text.
4. NO TRIVIA OR ROTE MEMORIZATION: Avoid testing rote memorization of paper titles or isolated facts. Instead, test the conceptual economic, statistical, or logical principles within the paper's framework, which you must explain in the setup.

COMPREHENSIVE REVIEW SYNTHESIS METHODOLOGY (HOW TO EXTRACT FROM CONTENT):
You must extract high-signal concepts from the provided Target Topic content and synthesize them into questions that mirror the style, depth, and layout of MIT MicroMasters Comprehensive Review exams:
1. EMPIRICAL/ECONOMETRIC SYNTHESIS: 
   - Identify the regression equation or causal identification strategy mentioned in the text (e.g. Difference-in-Differences, Instrumental Variables, or Regression Discontinuity).
   - Write a self-contained question that explicitly presents the regression equation (using clean LaTeX formatting, e.g., \( Y_{ic} = \alpha + \beta \text{Treatment}_c + \gamma X_i + \epsilon_{ic} \)), defines what each variable represents, and asks about the interpretation, bias, or sign of the coefficients (\(\beta\)).
2. THEORETICAL/MICROECONOMIC SYNTHESIS:
   - Identify the economic actor's decisions, payoffs, costs of effort, or utility functions described in the text (e.g., citizen-candidate entry costs, politician rent-seeking, or taxpayer bribe negotiation).
   - Present the math clearly (e.g., utility \( U_i = p(e) \cdot B - C(e) \)), explain each parameter, and ask questions requiring the student to identify the correct objective function, utility constraint, or the sign/implication of a derivative (e.g., \(\dfrac{db}{dr}\)).
3. RESEARCH METHODOLOGY & LOGISTICS SYNTHESIS:
   - Identify the survey design, field pilot, quality control, or IRB ethical principles discussed in the text (e.g., attrition bias, Minimum Detectable Effect standard deviations, dual-entry discrepancies, spot checks, or behavioral trust games).
   - Present a concrete, self-contained operational scenario (e.g., "A research team is administering surveys in-house...") and ask the student to identify the specific operational issue (e.g., differential coverage bias, social desirability, or telescoping), calculate the MDE, or explain the logical survey skip patterns.

CRITICAL FORMATTING & STRUCTURE INSTRUCTIONS:
1. EMPIRICAL DATA TABLES: When generating questions for empirical or measurement weeks, you are strongly encouraged to construct a realistic, clean Markdown data table representing survey audit discrepancies, sample allocation matrices, standard deviation blocks, or regression output coefficients. The question must then require the student to analyze, calculate, or interpret values directly from this Markdown table.
2. NO PLACEHOLDERS: Do not use spinner or loading image placeholders. All images, tables, and references must be fully specified or represented in text/markdown.

CRITICAL FORMAT SELECTION:
You MUST generate an exercise of type: "${targetType}".
Follow these rules strictly based on the target type:
- If "${targetType}" is "single_choice": Create a standard multiple choice question. 'choices' MUST contain exactly 4 options. 'correctAnswer' MUST be the exact matching string of the single correct answer.
- If "${targetType}" is "multiple_choice": Create a multiple-response check-box question (multiple correct answers allowed). 'choices' MUST contain 4 or 5 options. 'correctAnswer' MUST be a JSON array string containing all of the correct option texts (e.g. '["Option A", "Option C"]').
- If "${targetType}" is "numeric": Create a question requiring a numerical response. The 'choices' array MUST be completely empty ([]). The 'correctAnswer' MUST be a clean numeric string (e.g. "0.8" or "-0.07"). The 'questionText' should explicitly tell the student: "Please enter your numeric response rounded to two decimal places (for example, -0.07)".
- If "${targetType}" is "dropdown": Create a fill-in-the-blank sentence. The 'questionText' MUST contain exactly one "[Dropdown 1]" placeholder. The 'choices' array MUST contain 3 to 5 options that could fit in that blank. The 'correctAnswer' MUST be the exact correct literal word/option.`,
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
        id: `gen-${crypto.randomUUID()}`,
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

export async function generateExamDiagnosis(sessionId: string) {
  try {
    // 1. Fetch StudySession with logs, exercises and topics
    const session = await prisma.studySession.findUnique({
      where: { id: sessionId },
      include: {
        logs: {
          include: {
            exercise: {
              include: { topic: true }
            }
          }
        }
      }
    });

    if (!session || session.logs.length === 0) return null;

    // 2. Compute metrics (with proportional partial credit & negative marking rule)
    const totalCount = session.logs.length;
    let examScoreSum = 0;

    const topicPerformance: Record<string, { correct: number, total: number, localPath: string, week: string }> = {};
    const wrongAnswers: any[] = [];

    for (const log of session.logs) {
      const ex = log.exercise;
      const topic = ex.topic;
      const tTitle = topic?.title || "General Economics";
      const localPath = topic?.localPath || "";
      const week = topic?.week || "";

      let partialScore = 0;
      const draftAns = log.userAnswer || "";

      if (draftAns) {
        const isUserAnsArray = draftAns.startsWith('[') && draftAns.endsWith(']');
        const isCorrAnsArray = ex.correctAnswer.startsWith('[') && ex.correctAnswer.endsWith(']');

        if (isUserAnsArray) {
          try {
            const userAnsList = JSON.parse(draftAns);
            const correctAnsList = isCorrAnsArray ? JSON.parse(ex.correctAnswer) : [ex.correctAnswer];
            const choicesList = ex.choices ? JSON.parse(ex.choices) : [];

            const rightOptions = correctAnsList;
            const wrongOptions = choicesList.filter((c: string) => !correctAnsList.includes(c));

            const rightSelected = userAnsList.filter((c: string) => rightOptions.includes(c)).length;
            const wrongSelected = userAnsList.filter((c: string) => wrongOptions.includes(c)).length;

            const totalRight = rightOptions.length;
            if (totalRight > 0) {
              const netScore = (rightSelected - wrongSelected) / totalRight;
              partialScore = Math.max(0, netScore);
            }
          } catch {
            partialScore = 0;
          }
        } else if (ex.exerciseType === 'numeric') {
          const isCorrect = Math.abs(parseFloat(draftAns) - parseFloat(ex.correctAnswer)) < 0.01;
          partialScore = isCorrect ? 1.0 : 0.0;
        } else if (ex.exerciseType === 'dropdown') {
          let isCorrect = false;
          try {
            if (draftAns.startsWith('{') && draftAns.endsWith('}')) {
              const parsedUserAns = JSON.parse(draftAns);
              const isCorrAnsArray = ex.correctAnswer.startsWith('[') && ex.correctAnswer.endsWith(']');
              const correctAnsList = isCorrAnsArray ? JSON.parse(ex.correctAnswer) : [ex.correctAnswer];
              
              let matchedCount = 0;
              const totalDropdowns = Object.keys(parsedUserAns).length;
              
              for (const [key, userVal] of Object.entries(parsedUserAns)) {
                const cleanUserVal = String(userVal).trim().toLowerCase();
                const cleanKey = String(key).trim().toLowerCase();
                
                const isMatch = correctAnsList.some((corr: string) => {
                  const cleanCorr = String(corr).trim().toLowerCase();
                  if (cleanCorr.includes(cleanKey)) {
                    const cleanCorrVal = cleanCorr.replace(cleanKey, "").trim();
                    return cleanCorrVal === cleanUserVal || 
                           cleanCorrVal.replace(/\\+/g, "") === cleanUserVal.replace(/\\+/g, "");
                  }
                  return cleanCorr === cleanUserVal || 
                         cleanCorr.replace(/\\+/g, "") === cleanUserVal.replace(/\\+/g, "");
                });
                
                if (isMatch) matchedCount++;
              }
              
              if (totalDropdowns === 1) {
                const userVal = Object.values(parsedUserAns)[0];
                const cleanUserVal = String(userVal).trim().toLowerCase().replace(/\\+/g, "");
                const cleanCorr = String(correctAnsList[0]).trim().toLowerCase().replace(/\\+/g, "");
                isCorrect = cleanUserVal === cleanCorr;
              } else {
                isCorrect = matchedCount === totalDropdowns && totalDropdowns === correctAnsList.length;
              }
            } else {
              isCorrect = draftAns.trim().toLowerCase() === ex.correctAnswer.trim().toLowerCase();
            }
          } catch {
            isCorrect = draftAns.trim().toLowerCase() === ex.correctAnswer.trim().toLowerCase();
          }
          partialScore = isCorrect ? 1.0 : 0.0;
        } else {
          const isCorrect = draftAns.trim().toLowerCase() === ex.correctAnswer.trim().toLowerCase();
          partialScore = isCorrect ? 1.0 : 0.0;
        }
      }

      examScoreSum += partialScore;

      if (!topicPerformance[tTitle]) {
        topicPerformance[tTitle] = { correct: 0, total: 0, localPath, week };
      }
      topicPerformance[tTitle].total += 1;
      topicPerformance[tTitle].correct += partialScore; // Use precise proportional score

      if (partialScore < 1.0) {
        wrongAnswers.push({
          question: ex.questionText,
          userAnswer: log.userAnswer,
          correctAnswer: ex.correctAnswer,
          explanation: ex.explanation,
          topicTitle: tTitle,
          localPath,
          week,
          partialScore
        });
      }
    }

    const scorePct = Math.round((examScoreSum / totalCount) * 100);

    // Format metrics and data for the Gemini model to synthesize
    const topicSummaryString = Object.entries(topicPerformance).map(([title, stats]) => {
      const accuracy = Math.round((stats.correct / stats.total) * 100);
      return `- **${title}** (${stats.week}): ${stats.correct.toFixed(2)}/${stats.total} Correct (${accuracy}%). File: ${stats.localPath}`;
    }).join('\n');

    const wrongAnswersString = wrongAnswers.map((w, idx) => {
      return `### Question Review ${idx + 1}:
Topic: ${w.topicTitle}
Question: ${w.question}
User Answer: "${w.userAnswer || 'Unanswered'}"
Correct Answer: "${w.correctAnswer}"
Your Partial Score: ${w.partialScore.toFixed(2)}/1.00
Official Explanation: ${w.explanation || "No explanation available."}
Source File Path: ${w.localPath}`;
    }).join('\n\n');

    const prompt = `You are a brilliant MIT MicroMasters economics professor.
The student has completed a timed mock exam graded under a proportional partial credit "one wrong cancels one right" scoring protocol. You need to write a deeply professional, encouraging, and detailed analytical diagnostic report.

--- EXAM RESULTS OVERVIEW ---
Overall Proportional Score: ${examScoreSum.toFixed(2)}/${totalCount} (${scorePct}%)
Mode: ${session.mode} (Timed Exam)

--- TOPIC BREAKDOWNS ---
${topicSummaryString}

--- DETAILED WRONG ANSWERS & COGNITIVE MISTAKES ---
${wrongAnswersString || "No wrong answers! Perfect score!"}

Your output MUST be a gorgeous Markdown document structured exactly as follows:

# Timed Exam Diagnostic Report

## 1. Executive Performance Summary
Provide a 2-3 sentence overview of their performance. Be encouraging but academically rigorous. Highlight their immediate strengths.

## 2. Topic-by-Topic Mastery Breakdown
For each tested topic, assign one of these levels:
- **High Mastery** (Accuracy >= 80%): Short description of what they understand.
- **Developing Mastery** (Accuracy 50% - 79%): Identify small conceptual gaps.
- **Critical Remediation Needed** (Accuracy < 50%): Highlight foundational gaps.

## 3. Deep Error Deconstruction
Review each wrong answer. Explain the *cognitive trap* or economic misinterpretation they fell into (e.g., confusing OLS correlation with causality, failing to solve the first-order conditions, or forgetting how selection bias affects simple difference measures). Explain the underlying economic intuition clearly.

## 4. Tailored Study Plan & Grounding Map
Generate a clear, numbered list of study tasks.
For each task, refer to the exact lecture file (using its localPath) with a direct clickable Markdown link so they can click to open and review it in the Visualizer.
Format the links EXACTLY like this:
- For Slides PDFs: [Source Lecture Slides Title](/api/file?path=URL_ENCODED_LOCAL_PATH#page=ESTIMATED_PAGE_NUMBER) (choose an estimated page number, e.g., 5, where the concept is taught)
- For Transcripts/Readings: [Source Lecture Title](/api/file?path=URL_ENCODED_LOCAL_PATH&highlight=SHORT_UNIQUE_QUOTE_FROM_TEXT) (choose a 5-10 word unique quote from the text that they should review)

Example:
1. **Review Multi-stage Randomization**: Read page 15 of [Leaders and Democratic Institutions](/api/file?path=${encodeURIComponent('/Users/name/slides.pdf')}#page=15) to understand how the standard errors cluster.
2. **Re-evaluate OLS Coefficients**: Review the transcript [OLS Basics](/api/file?path=${encodeURIComponent('/Users/name/transcript.txt')}&highlight=estimate%20the%20OLS%20equation) to brush up on standard error interpretation.

Ensure that ALL file paths used in the links correspond to the actual ones listed in the breakdowns above. If no local file path was provided, use a placeholder. Do NOT invent external domains or paths outside of the provided localPaths.
`;

    const { text } = await generateText({
      model: google('gemini-3.6-flash'),
      prompt
    });

    // Save diagnosis to session
    await prisma.studySession.update({
      where: { id: sessionId },
      data: { diagnosis: text }
    });

    return text;
  } catch (error) {
    console.error("Failed to generate exam diagnosis:", error);
    return null;
  }
}

export async function generateGlobalDiagnosis() {
  try {
    // 1. Fetch all completed logs with exercises and topics
    const logs = await prisma.exerciseLog.findMany({
      include: {
        exercise: {
          include: { topic: true }
        }
      }
    });

    if (logs.length === 0) {
      return "No study session or exam logs found yet! Complete some exercises first so the professor can evaluate your performance.";
    }

    // 2. Group logs by topicId
    const topicStats: Record<string, { correct: number, total: number, title: string, course: string, week: string, localPath: string }> = {};
    for (const log of logs) {
      const ex = log.exercise;
      if (!ex || !ex.topic) continue;
      const topic = ex.topic;
      const tId = topic.id;

      if (!topicStats[tId]) {
        topicStats[tId] = {
          correct: 0,
          total: 0,
          title: topic.title || "General",
          course: topic.courseId || "General",
          week: topic.week || "",
          localPath: topic.localPath || ""
        };
      }
      topicStats[tId].total += 1;
      if (log.isCorrect) {
        topicStats[tId].correct += 1;
      }
    }

    // Sort topics by accuracy ascending
    const topicList = Object.entries(topicStats).map(([id, stats]) => {
      const accuracy = Math.round((stats.correct / stats.total) * 100);
      return { id, ...stats, accuracy };
    }).sort((a, b) => a.accuracy - b.accuracy);

    // Identify the top 4 weakest topics
    const weakTopics = topicList.filter(t => t.accuracy < 70).slice(0, 4);
    
    // Fetch detailed content for these weak topics to supply to the LLM
    const weakTopicIds = weakTopics.map(w => w.id);
    const detailedTopics = await prisma.topic.findMany({
      where: { id: { in: weakTopicIds } },
      include: { course: true }
    });

    const weakTopicsWithContent = weakTopics.map(wt => {
      const detail = detailedTopics.find(d => d.id === wt.id);
      let content = detail?.content || "No detailed content available.";
      if (content.length > 50000) {
        content = content.substring(0, 50000) + "...";
      }
      return {
        ...wt,
        courseCode: detail?.course?.code || "DEDP",
        content
      };
    });

    // Format stats and content summaries for prompt
    const allTopicsSummary = topicList.map(t => {
      return `- **${t.title}** (${t.course} - ${t.week}): ${t.correct}/${t.total} Correct (${t.accuracy}%). Source: ${t.localPath}`;
    }).join('\n');

    const weakTopicsContext = weakTopicsWithContent.map((wt, idx) => {
      return `### Weak Area ${idx + 1}: ${wt.title}
Course: ${wt.courseCode} (${wt.week})
Your Accuracy Score: ${wt.correct}/${wt.total} (${wt.accuracy}%)
Local File Path: ${wt.localPath}
Lecture Material Content Summary:
${wt.content}`;
    }).join('\n\n');

    const prompt = `You are a brilliant MIT MicroMasters economics professor acting as a Socratic Academic Advisor.
The student wants a comprehensive **Global Learning Diagnosis & Personalized Study Plan** based on their performance across ALL study and exam sessions.

--- GLOBAL PERFORMANCE METRICS ---
${allTopicsSummary}

--- RELEVANT CLASS CONTENT TRANSCRIPTIONS / SLIDES FOR WEAKEST AREAS ---
${weakTopicsContext || "No weak areas found! Perfect accuracy across all topics!"}

Your output MUST be a beautiful, highly thorough Markdown document structured exactly as follows:

# Global Learning Diagnostic Report

## 1. Executive Learning Profile
Provide a 3-4 sentence comprehensive analysis of their learning journey across both MITx courses (14.750x and JPAL102x). Identify high-level patterns (e.g. "strong on theoretical RCT layouts, but struggling on mathematical modeling, statistical sampling power, or empirical identification strategies"). Be encouraging but highly rigorous.

## 2. Global Topic Mastery Heatmap
Categorize their active topics into:
- **High Mastery** (Accuracy >= 75%)
- **Developing Mastery** (Accuracy 60% - 74%)
- **Critical Conceptual Gaps** (Accuracy < 60%)

## 3. Core Conceptual Gaps & Error Deconstructions
Analyze their weakest areas. Ground your explanations directly in the provided lecture transcriptions/slides above!
Detail the *precise theoretical or mathematical mistakes* they are making (e.g., explaining why adding more individual observations to clustered samples does not solve power issues if the Intra-cluster Correlation is high, or explaining Olken's media study designs in Indonesia, or Ferraz & Finan's re-election incentive model). Ensure this section is academically rich and deeply informative.

## 4. Tailored Remedial Syllabus & Clickable Grounding Map
Generate a clear, numbered list of study tasks linking directly to their weak areas.
For each task, refer to the exact lecture file (using its localPath) with a direct clickable Markdown link so they can click to open and review it in the Visualizer.
Format the links EXACTLY like this:
- For Slides PDFs: [Source Lecture Slides Title](/api/file?path=URL_ENCODED_LOCAL_PATH#page=ESTIMATED_PAGE_NUMBER) (choose an estimated page number, e.g., 5, where the concept is taught)
- For Transcripts/Readings: [Source Lecture Title](/api/file?path=URL_ENCODED_LOCAL_PATH&highlight=SHORT_UNIQUE_QUOTE_FROM_TEXT) (choose a 5-10 word unique quote from the text that they should review)

Example:
1. **Review Multi-stage Randomization**: Read page 15 of [Leaders and Democratic Institutions](/api/file?path=${encodeURIComponent('/Users/name/slides.pdf')}#page=15) to understand how the standard errors cluster.
2. **Re-evaluate OLS Coefficients**: Review the transcript [OLS Basics](/api/file?path=${encodeURIComponent('/Users/name/transcript.txt')}&highlight=estimate%20the%20OLS%20equation) to brush up on standard error interpretation.

Ensure that ALL file paths used in the links correspond to the actual ones listed in the breakdowns above. Do NOT invent external domains or paths outside of the provided localPaths.
`;

    const { text } = await generateText({
      model: google('gemini-3.6-flash'),
      prompt
    });

    // Create or update a special StudySession for the global diagnosis
    let globalSession = await prisma.studySession.findFirst({
      where: { mode: 'global_diagnosis' }
    });

    if (globalSession) {
      await prisma.studySession.update({
        where: { id: globalSession.id },
        data: { diagnosis: text, endTime: new Date() }
      });
    } else {
      await prisma.studySession.create({
        data: {
          title: "Global AI Learning Diagnosis",
          status: "completed",
          mode: "global_diagnosis",
          diagnosis: text,
          endTime: new Date()
        }
      });
    }

    return text;
  } catch (error) {
    console.error("Failed to generate global diagnosis:", error);
    return null;
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

export async function generatePlannerResponse(messages: any[], accuracyStats: any) {
  try {
    const formattedHistory = messages.map(m => {
      return `${m.role === 'user' ? 'Student' : 'Professor (Planner)'}: ${m.content}`;
    }).join('\n');

    const prompt = `You are an elite, warm MIT MicroMasters academic planner and Socratic curriculum advisor.
You are chatting with a student inside their "Study Plan Creator Workspace" to help them formulate their personalized study schedule timeline.

Here is the conversation history so far:
${formattedHistory}

Here is their current learning accuracy and heatmaps:
${JSON.stringify(accuracyStats)}

Your goal is to reply in 3-4 sentences. Be encouraging, intellectually rigorous, and follow these socratic guidelines:
1. Challenge their schedule: If they propose studying 6 hours a day or a very compact timeline, ask them about sustainability and the opportunity costs (what are they giving up?).
2. Discuss pedagogical techniques: Remind them of the importance of Active Recall and Spaced Repetition (e.g. testing themselves using timed mocks rather than passive reading).
3. Keep it brief: Be extremely concise, warm, and encourage them to click the "Compile Timeline Schedule" button when they feel ready to see the visual days/slots pre-created!
`;

    const { text } = await generateText({
      model: google('gemini-3.6-flash'),
      prompt
    });

    return text;
  } catch (error) {
    console.error("Failed to generate planner response:", error);
    return "I apologize, but I struggled to analyze your schedule feedback. Please try again!";
  }
}

// --- STRUCTURED STUDY PLAN PLANNERS ---

const StudyPlanSessionSchema = z.object({
  name: z.string(),
  day: z.string(),
  timeSlot: z.enum(['morning', 'afternoon', 'night', 'flexible']),
  durationMinutes: z.number(),
  mode: z.enum(['study', 'exam']),
  sourcingMix: z.number().min(0).max(100),
  focusDescription: z.string(),
  topicIds: z.array(z.string()), // Actual database Topic IDs mapped by Gemini
  questionCount: z.number()
});

const StudyPlanSchema = z.object({
  title: z.string(),
  executiveSummary: z.string(),
  sessions: z.array(StudyPlanSessionSchema)
});

export async function generateStructuredStudyPlan(chatMessages: any[], accuracyStats: any) {
  try {
    // Fetch actual database Topic catalog so Gemini can map correct IDs
    const dbTopics = await prisma.topic.findMany({
      select: { id: true, title: true, week: true, courseId: true }
    });

    const topicsCatalog = dbTopics.map(t => 
      `ID: "${t.id}" | Course: "${t.courseId}" | Week: "${t.week}" | Title: "${t.title}"`
    ).join('\n');

    const prompt = `You are an elite MIT MicroMasters academic advisor and syllabus curriculum designer.
A student wants you to create a structured, multi-day, personalized timeline Study Plan (curriculum) to prepare for their exams.

Here is their conversation history, containing their specific study preferences, available hours, and constraints:
${JSON.stringify(chatMessages)}

Here is their current learning accuracy and heatmaps:
${JSON.stringify(accuracyStats)}

Here is the exact Catalog of Topics available in the database (including their correct IDs, weeks, and titles):
${topicsCatalog}

CRITICAL PLANNING RULES:
1. Identify their weakest areas from the accuracy stats (prioritize areas with accuracy < 60%).
2. Schedule a chronological timeline (e.g. Tuesday through Friday, Morning/Afternoon/Night slots).
3. For each scheduled slot, you MUST assign actual, correct topic IDs from the provided database Catalog above. DO NOT invent topic IDs. Look at the Week or Title of the weak area, find its matching IDs in the Catalog, and insert those IDs inside the 'topicIds' array.
4. On the final days, schedule timed Mock Exams (using 'mode': 'exam') targeting Comprehensive Reviews (assign topics IDs matching Week 13/Week 16 comprehensive reviews).
5. Compile a type-safe JSON StudyPlan object matching the requested schema.
`;

    const { object } = await generateObject({
      model: google('gemini-3.6-flash'),
      schema: StudyPlanSchema,
      prompt
    });

    return object;
  } catch (error) {
    console.error("Failed to generate structured study plan:", error);
    return null;
  }
}

export async function saveAndDeployStudyPlan(planData: any) {
  try {
    // 1. Create the StudyPlan record
    const plan = await prisma.studyPlan.create({
      data: {
        title: planData.title,
        executiveSummary: planData.executiveSummary,
        status: "active"
      }
    });

    // 2. Loop over and pre-create each StudySession pre-populated
    for (const sessionData of planData.sessions) {
      // Find matching exercises in the database for the given topicIds to seed this session
      const exercises = await prisma.exercise.findMany({
        where: { topicId: { in: sessionData.topicIds } },
        take: sessionData.questionCount
      });

      const sessionTitle = `${sessionData.day} - ${sessionData.name}`;

      await prisma.studySession.create({
        data: {
          title: sessionTitle,
          status: "active",
          mode: sessionData.mode,
          timeLimit: sessionData.mode === 'exam' ? sessionData.durationMinutes * 60 : null,
          sourcingMix: sessionData.sourcingMix,
          exerciseIds: JSON.stringify(exercises.map(e => e.id)),
          studyPlanId: plan.id
        }
      });
    }

    return plan;
  } catch (error) {
    console.error("Failed to save and deploy study plan:", error);
    return null;
  }
}

export async function getStudyPlans() {
  try {
    return await prisma.studyPlan.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        sessions: {
          include: { logs: true }
        }
      }
    });
  } catch (error) {
    console.error("Failed to fetch study plans:", error);
    return [];
  }
}

export async function deleteStudyPlan(planId: string) {
  try {
    // Cascading deletion handles related StudySessions and ExerciseLogs automatically
    await prisma.studyPlan.delete({
      where: { id: planId }
    });
    return true;
  } catch (error) {
    console.error("Failed to delete study plan:", error);
    return false;
  }
}

export async function getTopicsWithPerformance() {
  try {
    const topics = await prisma.topic.findMany({
      orderBy: { week: 'asc' },
      include: { course: true }
    });

    const exercises = await prisma.exercise.findMany({
      select: { id: true, topicId: true }
    });

    const logs = await prisma.exerciseLog.findMany({
      select: { exerciseId: true, isCorrect: true }
    });

    // Compute metrics per topicId
    const topicMetrics = topics.map(t => {
      const topicExercises = exercises.filter(e => e.topicId === t.id);
      const totalExercises = topicExercises.length;

      const exerciseIds = topicExercises.map(e => e.id);
      const topicLogs = logs.filter(l => exerciseIds.includes(l.exerciseId));
      
      const totalLogged = topicLogs.length;
      const correctCount = topicLogs.filter(l => l.isCorrect).length;

      // Uniquely completed exercises
      const uniquelyCompleted = new Set(topicLogs.map(l => l.exerciseId)).size;

      const accuracy = totalLogged > 0 ? Math.round((correctCount / totalLogged) * 100) : null;
      const coverage = totalExercises > 0 ? Math.round((uniquelyCompleted / totalExercises) * 100) : 0;

      return {
        id: t.id,
        title: t.title,
        week: t.week,
        className: t.className,
        unit: t.unit,
        courseCode: t.course?.code || "DEDP",
        course: t.course ? { id: t.course.id, code: t.course.code, title: t.course.title } : null,
        totalExercises,
        uniquelyCompleted,
        accuracy,
        coverage
      };
    });

    return topicMetrics;
  } catch (error) {
    console.error("Failed to fetch topics with performance:", error);
    return [];
  }
}

export async function getTopicEvolutionData() {
  try {
    // 1. Fetch all completed ExerciseLogs with timestamps and exercises details
    const logs = await prisma.exerciseLog.findMany({
      orderBy: { timestamp: 'asc' },
      include: {
        exercise: {
          include: {
            topic: {
              include: { course: true }
            }
          }
        }
      }
    });

    if (logs.length === 0) {
      return { 
        courseData: [], weekData: [], topicData: [],
        courseCoverageData: [], weekCoverageData: [], topicCoverageData: []
      };
    }

    // Fetch all available exercises in the DB to count total pools for coverage calculation
    const allExercises = await prisma.exercise.findMany({
      include: {
        topic: {
          include: { course: true }
        }
      }
    });

    const courseTotals: Record<string, number> = {};
    const weekTotals: Record<string, number> = {};
    const topicTotals: Record<string, number> = {};

    allExercises.forEach(e => {
      const cCode = e.topic?.course?.code || "DEDP";
      const wName = e.topic?.week || "General";
      const wTitle = `${cCode} - ${wName.replace(/_+/g, ' ').trim()}`;
      const tTitle = e.topic?.title || "General";

      courseTotals[cCode] = (courseTotals[cCode] || 0) + 1;
      weekTotals[wTitle] = (weekTotals[wTitle] || 0) + 1;
      topicTotals[tTitle] = (topicTotals[tTitle] || 0) + 1;
    });

    // 2. Identify unique dates (formatted as MM/DD)
    const datesSet = new Set<string>();
    const logsWithFormattedDate = logs.map(l => {
      const d = new Date(l.timestamp);
      const formattedDate = `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`;
      datesSet.add(formattedDate);
      
      const wName = l.exercise?.topic?.week || "General";
      const wCleaned = wName.replace(/_+/g, ' ').trim();
      
      return {
        ...l,
        formattedDate,
        courseCode: l.exercise?.topic?.course?.code || "DEDP",
        weekTitle: wCleaned,
        topicTitle: l.exercise?.topic?.title || "General"
      };
    });

    const sortedDates = Array.from(datesSet).sort();

    // Grouping buffers
    const courseGroup: Record<string, Record<string, { correct: number, total: number, exerciseIds: Set<string> }>> = {};
    const weekGroup: Record<string, Record<string, { correct: number, total: number, exerciseIds: Set<string> }>> = {};
    const topicGroup: Record<string, Record<string, { correct: number, total: number, exerciseIds: Set<string> }>> = {};

    for (const d of sortedDates) {
      courseGroup[d] = {};
      weekGroup[d] = {};
      topicGroup[d] = {};
    }

    // Accumulate scores
    for (const l of logsWithFormattedDate) {
      const d = l.formattedDate;
      const cCode = l.courseCode;
      const wTitle = `${cCode} - ${l.weekTitle}`;
      const tTitle = l.topicTitle;
      const exId = l.exerciseId;

      // Course Level (Macro)
      if (!courseGroup[d][cCode]) courseGroup[d][cCode] = { correct: 0, total: 0, exerciseIds: new Set() };
      courseGroup[d][cCode].total += 1;
      courseGroup[d][cCode].exerciseIds.add(exId);
      if (l.isCorrect) courseGroup[d][cCode].correct += 1;

      // Week Level (Meso)
      if (!weekGroup[d][wTitle]) weekGroup[d][wTitle] = { correct: 0, total: 0, exerciseIds: new Set() };
      weekGroup[d][wTitle].total += 1;
      weekGroup[d][wTitle].exerciseIds.add(exId);
      if (l.isCorrect) weekGroup[d][wTitle].correct += 1;

      // Topic Level (Micro)
      if (!topicGroup[d][tTitle]) topicGroup[d][tTitle] = { correct: 0, total: 0, exerciseIds: new Set() };
      topicGroup[d][tTitle].total += 1;
      topicGroup[d][tTitle].exerciseIds.add(exId);
      if (l.isCorrect) topicGroup[d][tTitle].correct += 1;
    }

    // Compile into flat timelines with running cumulative averages and coverages
    const courseRunning: Record<string, { correct: number, total: number }> = {};
    const weekRunning: Record<string, { correct: number, total: number }> = {};
    const topicRunning: Record<string, { correct: number, total: number }> = {};

    const courseUniqueIds: Record<string, Set<string>> = {};
    const weekUniqueIds: Record<string, Set<string>> = {};
    const topicUniqueIds: Record<string, Set<string>> = {};

    const courseData: any[] = [];
    const weekData: any[] = [];
    const topicData: any[] = [];

    const courseCoverageData: any[] = [];
    const weekCoverageData: any[] = [];
    const topicCoverageData: any[] = [];

    for (const d of sortedDates) {
      // --- Course Level ---
      const courseObj: Record<string, any> = { date: d };
      const courseCovObj: Record<string, any> = { date: d };

      Object.entries(courseGroup[d]).forEach(([key, stats]) => {
        if (!courseRunning[key]) courseRunning[key] = { correct: 0, total: 0 };
        courseRunning[key].correct += stats.correct;
        courseRunning[key].total += stats.total;

        if (!courseUniqueIds[key]) courseUniqueIds[key] = new Set();
        stats.exerciseIds.forEach(id => courseUniqueIds[key].add(id));
      });

      Object.entries(courseRunning).forEach(([key, stats]) => {
        courseObj[key] = Math.round((stats.correct / stats.total) * 100);
      });
      courseData.push(courseObj);

      Object.entries(courseUniqueIds).forEach(([key, uniqueSet]) => {
        const totalPool = courseTotals[key] || 1;
        courseCovObj[key] = Math.round((uniqueSet.size / totalPool) * 100);
      });
      courseCoverageData.push(courseCovObj);

      // --- Week Level ---
      const weekObj: Record<string, any> = { date: d };
      const weekCovObj: Record<string, any> = { date: d };

      Object.entries(weekGroup[d]).forEach(([key, stats]) => {
        if (!weekRunning[key]) weekRunning[key] = { correct: 0, total: 0 };
        weekRunning[key].correct += stats.correct;
        weekRunning[key].total += stats.total;

        if (!weekUniqueIds[key]) weekUniqueIds[key] = new Set();
        stats.exerciseIds.forEach(id => weekUniqueIds[key].add(id));
      });

      Object.entries(weekRunning).forEach(([key, stats]) => {
        weekObj[key] = Math.round((stats.correct / stats.total) * 100);
      });
      weekData.push(weekObj);

      Object.entries(weekUniqueIds).forEach(([key, uniqueSet]) => {
        const totalPool = weekTotals[key] || 1;
        weekCovObj[key] = Math.round((uniqueSet.size / totalPool) * 100);
      });
      weekCoverageData.push(weekCovObj);

      // --- Topic Level ---
      const topicObj: Record<string, any> = { date: d };
      const topicCovObj: Record<string, any> = { date: d };

      Object.entries(topicGroup[d]).forEach(([key, stats]) => {
        if (!topicRunning[key]) topicRunning[key] = { correct: 0, total: 0 };
        topicRunning[key].correct += stats.correct;
        topicRunning[key].total += stats.total;

        if (!topicUniqueIds[key]) topicUniqueIds[key] = new Set();
        stats.exerciseIds.forEach(id => topicUniqueIds[key].add(id));
      });

      Object.entries(topicRunning).forEach(([key, stats]) => {
        topicObj[key] = Math.round((stats.correct / stats.total) * 100);
      });
      topicData.push(topicObj);

      Object.entries(topicUniqueIds).forEach(([key, uniqueSet]) => {
        const totalPool = topicTotals[key] || 1;
        topicCovObj[key] = Math.round((uniqueSet.size / totalPool) * 100);
      });
      topicCoverageData.push(topicCovObj);
    }

    return { 
      courseData, 
      weekData, 
      topicData,
      courseCoverageData,
      weekCoverageData,
      topicCoverageData
    };
  } catch (error) {
    console.error("Failed to generate topic evolution data:", error);
    return { 
      courseData: [], weekData: [], topicData: [],
      courseCoverageData: [], weekCoverageData: [], topicCoverageData: []
    };
  }
}

export async function getCourseArtifacts() {
  try {
    return await getCourseArtifactsService();
  } catch (error) {
    console.error("Failed to get course artifacts:", error);
    return [];
  }
}

export async function generateWeekSummaryAction(courseCode: string, weekName: string) {
  try {
    return await generateWeekSummaryService(courseCode, weekName);
  } catch (error: any) {
    console.error(`Error generating week summary for ${courseCode} ${weekName}:`, error);
    throw error;
  }
}
