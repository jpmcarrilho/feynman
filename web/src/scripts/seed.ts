import 'dotenv/config'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';
import { PrismaClient } from '@prisma/client'
import Database from 'better-sqlite3'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { parseRegistryCsv, parsePdfBuffer, parseExerciseMarkdown } from '../services/ingest'

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Starting seed process...');

  // The CSV and course files are located one folder up from 'web', in 'MIT_Learn_Courses'
  const baseDir = path.resolve(process.cwd(), '../MIT_Learn_Courses');
  const csvPath = path.join(baseDir, 'resources_registry.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found at ${csvPath}`);
    return;
  }

  const records = parseRegistryCsv(csvPath);
  console.log(`Found ${records.length} records in the CSV.`);

  for (const row of records) {
    const courseId = row['Course'];
    if (!courseId) continue;

    // 1. Ensure the Course exists in the database
    const course = await prisma.course.upsert({
      where: { code: courseId },
      update: {},
      create: {
        code: courseId,
        title: courseId, // E.g., "14.750x"
        description: `Auto-generated course for ${courseId}`
      }
    });

    const localPath = row['Local Path'];
    const fullPath = localPath.startsWith('/') ? localPath : path.join(baseDir, localPath);

    let rawText = '';
    let content = '';
    
    // 2. Read and parse the actual file or directory
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        if (fullPath.toLowerCase().endsWith('.pdf')) {
          const buffer = fs.readFileSync(fullPath);
          content = await parsePdfBuffer(buffer);
        } else {
          rawText = fs.readFileSync(fullPath, 'utf-8');
          content = rawText;
        }
      } else if (stat.isDirectory()) {
        const files = fs.readdirSync(fullPath);
        for (const file of files) {
          const filePath = path.join(fullPath, file);
          if (fs.statSync(filePath).isFile()) {
            if (filePath.toLowerCase().endsWith('.pdf')) {
              const buffer = fs.readFileSync(filePath);
              content += await parsePdfBuffer(buffer) + '\n\n';
            } else {
              rawText += fs.readFileSync(filePath, 'utf-8') + '\n\n';
            }
          }
        }
        if (!content) {
            content = rawText;
        } else if (rawText) {
            content += '\n\n' + rawText;
        }
      }

      // 3. Save the Topic with full hierarchy data
      const topic = await prisma.topic.create({
        data: {
          courseId: course.id,
          week: row['Week'],
          className: row['Class / Sequential'],
          unit: row['Unit Number'],
          title: row['Unit Title'],
          resourceType: row['Resource Type'],
          localPath: localPath,
          content: content
        }
      });
      console.log(`Created topic: [${topic.week}] ${topic.title}`);

      // 4. If it's an exercise, parse it into individual flashcards/questions
      if (row['Resource Type'].toLowerCase().includes('exercise') || localPath.toLowerCase().includes('question') || localPath.endsWith('.md')) {
        const exercises = parseExerciseMarkdown(rawText);
        
        let exCount = 0;
        for (const ex of exercises) {
          if (!ex.correctAnswer || ex.choices.length === 0) continue;
          await prisma.exercise.create({
            data: {
              topicId: topic.id,
              questionText: ex.questionText,
              choices: JSON.stringify(ex.choices), 
              correctAnswer: ex.correctAnswer,
              explanation: ex.explanation,
              exerciseType: ex.exerciseType || 'single_choice'
            }
          });
          exCount++;
        }
        if (exCount > 0) {
          console.log(`  -> Added ${exCount} exercises to the database.`);
        }
      }
    } else {
      console.warn(`  [Warning] File not found on disk: ${fullPath}`);
    }
  }

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });