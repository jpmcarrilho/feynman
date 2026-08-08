import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function runSimulation() {
  // 1. Fetch topics for JPAL102x Weeks 7, 8, 9
  const course = await prisma.course.findUnique({
    where: { code: 'JPAL102x' }
  });
  if (!course) {
    console.error('Course JPAL102x not found.');
    return;
  }

  const targetWeeks = [
    'Week_07_Measurement___I__Intro__Market',
    'Week_08_Measurement___II__Sensitive_Qu',
    'Week_09_Measurement___III__Behavior__G'
  ];

  const topics = await prisma.topic.findMany({
    where: {
      courseId: course.id,
      week: { in: targetWeeks }
    },
    include: { _count: { select: { exercises: true } } }
  });

  const topicIds = topics.map(t => t.id);

  // Fetch all exercises for these topics
  const exercises = await prisma.exercise.findMany({
    where: { topicId: { in: topicIds } },
    include: { topic: true }
  });

  console.log(`\n================================================================`);
  console.log(`📊 DATABASE STATISTICS (JPAL102x Weeks 7, 8, 9)`);
  console.log(`================================================================`);
  console.log(`Total Selected Topics (Units): ${topics.length}`);
  console.log(`Total Exercises in Database: ${exercises.length}`);
  console.log(`\nExercise Counts by Unit in DB:`);
  topics.forEach(t => {
    if (t._count.exercises > 0) {
      console.log(`- [${t._count.exercises.toString().padStart(2)}] Exercises: ${t.title}`);
    }
  });

  // Target count of pre-existing questions to select: say 25 questions
  const count = 50;
  const targetCount = Math.floor(count / 2); // 25 questions

  // ----------------------------------------------------------------
  // SIMULATION 1: Old Algorithm (Global Shuffle & Slice)
  // ----------------------------------------------------------------
  const oldShuffled = [...exercises];
  for (let i = oldShuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [oldShuffled[i], oldShuffled[j]] = [oldShuffled[j], oldShuffled[i]];
  }
  const oldSelected = oldShuffled.slice(0, Math.min(oldShuffled.length, targetCount));

  const oldDistribution: Record<string, number> = {};
  topics.forEach(t => oldDistribution[t.id] = 0);
  oldSelected.forEach(ex => oldDistribution[ex.topicId]++);

  // ----------------------------------------------------------------
  // SIMULATION 2: New Algorithm (Topic Bucketed Round-Robin)
  // ----------------------------------------------------------------
  const groups: Record<string, any[]> = {};
  for (const id of topicIds) {
    groups[id] = [];
  }
  for (const ex of exercises) {
    if (groups[ex.topicId] !== undefined) {
      groups[ex.topicId].push(ex);
    }
  }

  // Shuffle within each group
  for (const id of topicIds) {
    const group = groups[id];
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
  }

  const newSelected: any[] = [];
  
  // Shuffle topic IDs to randomize starting order and selection when T > G
  const shuffledTopicIds = [...topicIds];
  for (let i = shuffledTopicIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledTopicIds[i], shuffledTopicIds[j]] = [shuffledTopicIds[j], shuffledTopicIds[i]];
  }

  let added = true;
  while (newSelected.length < targetCount && added) {
    added = false;
    for (const id of shuffledTopicIds) {
      if (newSelected.length >= targetCount) break;
      const group = groups[id];
      if (group && group.length > 0) {
        newSelected.push(group.pop());
        added = true;
      }
    }
  }

  const newDistribution: Record<string, number> = {};
  topics.forEach(t => newDistribution[t.id] = 0);
  newSelected.forEach(ex => newDistribution[ex.topicId]++);

  // ----------------------------------------------------------------
  // OUTPUT SIDE-BY-SIDE COMPARISON
  // ----------------------------------------------------------------
  console.log(`\n================================================================`);
  console.log(`🎯 ALGORITHM COMPARISON: Selecting ${targetCount} Exercises`);
  console.log(`================================================================`);
  console.log(`${'Unit/Topic'.padEnd(45)} | ${'DB Total'.padStart(8)} | ${'Old Alg'.padStart(8)} | ${'New Alg (RR)'.padStart(8)}`);
  console.log(`-`.repeat(80));

  topics.forEach(t => {
    if (t._count.exercises > 0) {
      const title = t.title.length > 42 ? t.title.substring(0, 42) + '...' : t.title;
      const dbTotal = t._count.exercises.toString();
      const oldVal = (oldDistribution[t.id] || 0).toString();
      const newVal = (newDistribution[t.id] || 0).toString();
      console.log(`${title.padEnd(45)} | ${dbTotal.padStart(8)} | ${oldVal.padStart(8)} | ${newVal.padStart(8)}`);
    }
  });
  console.log(`-`.repeat(80));
  console.log(`${'TOTALS'.padEnd(45)} | ${exercises.length.toString().padStart(8)} | ${oldSelected.length.toString().padStart(8)} | ${newSelected.length.toString().padStart(8)}`);
  console.log(`================================================================\n`);
}

runSimulation();
