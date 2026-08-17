import { prisma } from '@/lib/db'
import fs from 'fs'
import path from 'path'
import { generateText } from 'ai'
import { google } from '@ai-sdk/google'

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

  const prompt = `You are a brilliant, world-class professor specializing in economics and public policy (MIT MicroMasters style), embodying the Feynman learning philosophy.
Your task is to generate a comprehensive, highly detailed permanent study guide and week summary for the following course week:

Course: ${courseCode} - ${course.title}
Week: ${weekName}

CRITICAL DIRECTIVES:
1. Grounded in Lesson Content: This is a permanent, high-quality textbook study guide. You must use the actual Covered Material Context (the lecture transcripts, slides outlines, and textbook readings) to summarize and explain the core academic concepts. 
2. Be concise and simplified: Adhere to the Feynman Technique of making concepts incredibly simple and intuitive using elegant, grounded analogies (like bongos, water-flows, or balance scales), but do not be overly verbose or repetitive.
3. No Question Leakage: Under no circumstances should you generate or refer to specific sample questions or tests. Focus 100% on the core lecture topics and learning objectives.

Covered Material Context (Extracted slides, transcripts, and reading content for this week):
${materialContext || 'No raw lesson materials available.'}

Generate a beautifully styled Markdown document. Break it down into these exact sections:
1. # 📓 Course Study Guide: ${courseCode} | ${weekName}
   An elegant overview of this week's topics, general learning objectives, and core themes.
2. ## 🧠 Concepts Demystified (Feynman Style)
   Explain the main 2-3 core academic concepts covered in this week's materials. Explain each one in simple terms, using an elegant analogy to convey the underlying economics or policy intuition.
3. ## 🔍 Common Pitfalls & Key Terms
   Identify common misconceptions, tricky details, or academic traps in these specific topics, and explain how to understand them correctly from first principles.
4. ## 📝 Custom Class Cheat Sheet
   A bulleted, extremely concise reference summarizing key equations, core definitions, or central principles from these specific lectures.
5. ## 🚀 Recommended Next Steps
   Suggested concrete review goals (e.g., specific slides, read-throughs, or topic units).

Ensure all equations are nicely formatted in standard LaTeX format when appropriate (wrap math blocks in $$ block $$ or $ inline $).`;

  const { text } = await generateText({
    model: google('gemini-3.6-flash'),
    prompt,
  });

  fs.writeFileSync(weekSummaryFilePath, text, 'utf8');

  return { filePath: weekSummaryFilePath, content: text };
}