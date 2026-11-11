import { prisma } from '@/lib/db'
import fs from 'fs'
import path from 'path'
import { generateText } from 'ai'
import { textModel } from '@/lib/ai'
import { moduleSummaryPrompt } from '@/lib/prompts'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'
import { summaryLink, topicFileLink } from '@/lib/fileLinks'
import { findSummaryFile, newSummaryFilePath, summaryKey } from '@/server/storage'

/**
 * Retrieves all courses and groups their resources (slides, transcriptions, exercises)
 * into a weekly structured hierarchy. With a courseId only that course is returned.
 */
export async function getCourseArtifactsService(courseId?: string) {
  const courses = await prisma.course.findMany({
    where: courseId ? { id: courseId } : undefined,
    orderBy: { code: 'asc' }
  });

  const topics = await prisma.topic.findMany({
    where: courseId ? { courseId } : undefined,
    orderBy: [{ week: 'asc' }, { order: 'asc' }], // module label first, outline order inside it
    include: { course: true, exercises: { where: { origin: 'imported', status: 'active', isGraded: true }, select: { id: true } } }
  });

  const results = courses.map(course => {
    const courseTopics = topics.filter(t => t.courseId === course.id);
    
    // Group by week
    const weeksMap = new Map<string, typeof courseTopics>();
    courseTopics.forEach(t => {
      if (t.week) {
        if (!weeksMap.has(t.week)) {
          weeksMap.set(t.week, []);
        }
        weeksMap.get(t.week)!.push(t);
      }
    });

    const weeksList = Array.from(weeksMap.entries()).map(([weekName, weekTopics]) => {
      const weekFileSlug = weekName.replace(/\s+/g, '_');
      const key = summaryKey(weekName);
      const summaryExists = key !== null && findSummaryFile(course, key) !== null;

      // Group topics into slides, transcriptions, exercises
      const slides: any[] = [];
      const transcriptions: any[] = [];
      const topicIds = weekTopics.map(t => t.id);
      let exercisesCount = 0;

      weekTopics.forEach(t => {
        exercisesCount += t.exercises.length;
        
        const resource = {
          id: t.id,
          title: t.title,
          unit: t.unit,
          className: t.className,
          resourceType: t.resourceType,
          link: topicFileLink(t.id)
        };

        const typeLower = (t.resourceType || '').toLowerCase();
        const pathLower = (t.localPath || '').toLowerCase();
        if (typeLower.includes('slides') || typeLower.includes('pdf') || pathLower.endsWith('.pdf')) {
          slides.push(resource);
        } else if (typeLower.includes('transcript') || typeLower.includes('reading') || typeLower.includes('.txt') || pathLower.endsWith('.txt') || pathLower.endsWith('.md')) {
          transcriptions.push(resource);
        } else {
          if (typeLower.includes('video') || typeLower.includes('content') || typeLower.includes('text')) {
            transcriptions.push(resource);
          } else {
            slides.push(resource);
          }
        }
      });

      return {
        weekName,
        weekSlug: weekFileSlug,
        summaryExists,
        summaryLink: summaryExists && key ? summaryLink(course.id, key) : null,
        slides,
        transcriptions,
        exercisesCount,
        topicIds
      };
    });

    // Filter out any courses that have no weeks/materials
    return {
      courseId: course.id,
      courseCode: course.code,
      courseTitle: course.title,
      weeks: weeksList.filter(w => w.slides.length > 0 || w.transcriptions.length > 0)
    };
  }).filter(c => c.weeks.length > 0);

  return results;
}

/**
 * Checks if a week's summary guide exists, otherwise loads raw content and triggers
 * OpenAI/Gemini to write a comprehensive Feynman textbook summary.
 */
export async function generateWeekSummaryService(courseCode: string, weekName: string) {
  const course = await prisma.course.findUnique({ where: { code: courseCode } });
  if (!course) {
    throw new Error(`Course ${courseCode} not found`);
  }

  const key = summaryKey(weekName);
  if (!key) {
    throw new Error(`Invalid module name: ${weekName}`);
  }

  const existing = findSummaryFile(course, key);
  if (existing) {
    const content = fs.readFileSync(existing, 'utf8');
    return { link: summaryLink(course.id, key), content };
  }

  const classTopics = await prisma.topic.findMany({
    where: {
      courseId: course.id,
      week: weekName
    }
  });

  let materialContext = '';
  classTopics.forEach(t => {
    let topicContent = t.content || 'No outline transcription available.';
    if (topicContent.length > 15000) {
      topicContent = topicContent.substring(0, 15000) + '\n\n[...Content truncated for context efficiency...]';
    }
    materialContext += `--- Lesson Name: ${t.className || 'Unknown'} | Topic Unit: ${t.title} ---\n`;
    materialContext += `Content/Transcription Outline:\n${topicContent}\n\n`;
  });

  const prompt = moduleSummaryPrompt(resolveProfile(course), {
    courseCode,
    courseTitle: course.title,
    module: weekName,
    material: materialContext,
  });

  const { text } = await generateText({
    model: textModel(),
    prompt,
  });

  // New summaries always go under storage/summaries/<courseId>/
  const target = newSummaryFilePath(course, key);
  if (!target) {
    throw new Error(`Invalid module name: ${weekName}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');

  return { link: summaryLink(course.id, key), content: text };
}