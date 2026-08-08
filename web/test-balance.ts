import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

const formatDisplayName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .replace(/_+/g, ' ')
    .trim();
}

async function inspectQuestionQuality() {
  const lastSession = await prisma.studySession.findFirst({
    orderBy: { startTime: 'desc' }
  });

  if (!lastSession || !lastSession.exerciseIds) {
    console.log("No study sessions found!");
    return;
  }

  const exerciseIds = JSON.parse(lastSession.exerciseIds) as string[];
  const exercises = await prisma.exercise.findMany({
    where: { id: { in: exerciseIds } },
    include: { topic: true }
  });

  // Keep original order
  const orderedExercises = exerciseIds.map(id => exercises.find(e => e.id === id)).filter(Boolean);

  console.log(`\n================================================================`);
  console.log(`🔍 DETAILED QUALITY AUDIT FOR STUDY SESSION QUESTIONS`);
  console.log(`================================================================`);
  console.log(`Auditing 4 representative questions from your active session...`);

  // We choose 4 interesting ones to print in full: 2 AI-generated, 2 DB-pulled (or whatever is in there)
  const indicesToInspect = [0, 1, 10, 15]; // Audit 1st, 2nd, 11th, and 16th exercises

  indicesToInspect.forEach(index => {
    if (index >= orderedExercises.length) return;
    const ex: any = orderedExercises[index];
    const weekClean = formatDisplayName(ex.topic.week);
    const topicTitle = ex.topic.title || 'Unknown';
    const isAiGenerated = ex.id.startsWith('gen-') || !ex.localPath;
    const sourceLabel = isAiGenerated ? '✨ AI-Generated' : '📦 DB-Pulled';

    console.log(`\n----------------------------------------------------------------`);
    console.log(`🔴 QUESTION #${index + 1} | [${sourceLabel}] [${weekClean}]`);
    console.log(`   Topic: "${topicTitle}"`);
    console.log(`   Type:  ${ex.exerciseType.toUpperCase()}`);
    console.log(`----------------------------------------------------------------`);
    
    // Clean and print question text
    const cleanText = ex.questionText.replace(/<!-- enriched -->\n/, '').trim();
    console.log(`\n[QUESTION]:`);
    console.log(cleanText);

    // Parse and print choices
    try {
      const choices = JSON.parse(ex.choices);
      if (choices && choices.length > 0) {
        console.log(`\n[CHOICES]:`);
        choices.forEach((c: string, idx: number) => {
          const letter = String.fromCharCode(65 + idx);
          console.log(`  ${letter}) ${c}`);
        });
      }
    } catch (e) {
      // Numerical or non-choice
    }

    // Print correct answer
    console.log(`\n[CORRECT ANSWER]:`);
    console.log(`  => ${ex.correctAnswer}`);

    // Print explanation if available
    if (ex.explanation) {
      console.log(`\n[EXPLANATION]:`);
      console.log(`  ${ex.explanation}`);
    }
  });
  console.log(`================================================================\n`);
}

inspectQuestionQuality();
