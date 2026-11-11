import { prisma } from '@/lib/db'
import fs from 'fs'
import path from 'path'
import { generateText } from 'ai'
import { textModel } from '@/lib/ai'
import { moduleSummaryPrompt } from '@/lib/prompts'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'

/**
 * Retrieves all courses and groups their resources (slides, transcriptions, exercises)
 * into a weekly structured hierarchy.
 */
export async function getCourseArtifactsService() {
  const courses = await prisma.course.findMany({
    orderBy: { code: 'asc' }
  });

  const topics = await prisma.topic.findMany({
    orderBy: { week: 'asc' },
    include: { course: true, exercises: { select: { id: true } } }
  });

  const summariesDir = path.join(process.cwd(), 'summaries');

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
      const summaryFilePath = path.join(summariesDir, course.code, `${weekFileSlug}.md`);
      const summaryExists = fs.existsSync(summaryFilePath);

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
          localPath: t.localPath
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
        summaryPath: summaryExists ? summaryFilePath : null,
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

  const summariesDir = path.join(process.cwd(), 'summaries');
  const courseDir = path.join(summariesDir, courseCode);
  if (!fs.existsSync(courseDir)) {
    fs.mkdirSync(courseDir, { recursive: true });
  }

  const weekFileSlug = weekName.replace(/\s+/g, '_');
  const weekSummaryFilePath = path.join(courseDir, `${weekFileSlug}.md`);

  if (fs.existsSync(weekSummaryFilePath)) {
    const content = fs.readFileSync(weekSummaryFilePath, 'utf8');
    return { filePath: weekSummaryFilePath, content };
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
    materialContext += `Content/Transcription Outline:\n${topicContent}\n`;
    materialContext += `Local Slides/Reading Path: ${t.localPath || 'None'}\n\n`;
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

  fs.writeFileSync(weekSummaryFilePath, text, 'utf8');

  return { filePath: weekSummaryFilePath, content: text };
}