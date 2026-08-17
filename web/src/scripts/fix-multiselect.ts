import 'dotenv/config'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';
import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("=== DRY RUN: Testing Multi-Select Identification Rule ===");
  console.log("Reading exercises from database... (No updates will be written)\n");

  const exercises = await prisma.exercise.findMany();
  let mislabeledCount = 0;

  for (const ex of exercises) {
    const qTextLower = ex.questionText.toLowerCase();
    const isMultiSelectText = qTextLower.includes('select all that apply') || 
                             qTextLower.includes('choose all that apply') ||
                             qTextLower.includes('select all correct');

    if (isMultiSelectText && ex.exerciseType === 'single_choice') {
      mislabeledCount++;
      let proposedAnswer = ex.correctAnswer;
      try {
        JSON.parse(ex.correctAnswer);
      } catch {
        proposedAnswer = JSON.stringify([ex.correctAnswer]);
      }

      console.log(`[PROPOSED UPGRADE] ID: "${ex.id}"`);
      console.log(`- Current Type: "single_choice"  -> Proposed Type: "multiple_choice"`);
      console.log(`- Current Answer: "${ex.correctAnswer}" -> Proposed Answer Array: "${proposedAnswer}"`);
      console.log(`- Question Text: "${ex.questionText.substring(0, 120).trim()}..."`);
      console.log("-".repeat(80));
    }
  }

  console.log(`\n=== DRY RUN RESULTS ===`);
  console.log(`Total checked exercises in DB: ${exercises.length}`);
  console.log(`Mislabeled multi-select exercises identified: ${mislabeledCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
