import 'dotenv/config'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';
import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function main() {
  const ex = await prisma.exercise.findFirst({
    where: {
      questionText: {
        contains: "In a cluster randomized evaluation, doubling the sample size will"
      }
    }
  });

  if (ex) {
    await prisma.exercise.update({
      where: { id: ex.id },
      data: {
        exerciseType: 'single_choice',
        correctAnswer: 'Not enough information'
      }
    });
    console.log("Successfully fixed Exercise 4 inside the SQLite database!");
  } else {
    console.log("Could not locate Exercise 4 in the database.");
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
