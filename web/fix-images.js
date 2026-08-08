require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const Database = require('better-sqlite3');

const db = new Database('./dev.db');
const adapter = new PrismaBetterSqlite3(db);
const prisma = new PrismaClient({ adapter });

async function fixImages() {
  const exercises = await prisma.exercise.findMany();
  let fixedCount = 0;

  for (const ex of exercises) {
    if (!ex.explanation) continue;

    const imgRegex = /https:\/\/[^\s]+\.(png|jpg|jpeg|gif)/gi;
    const matches = ex.explanation.match(imgRegex);

    if (matches && matches.length > 0) {
      let needsFix = false;
      let newQuestionText = ex.questionText;

      for (const img of matches) {
        if (!newQuestionText.includes(img)) {
          newQuestionText = `![](${img})\n\n${newQuestionText}`;
          needsFix = true;
        }
      }

      if (needsFix) {
        await prisma.exercise.update({
          where: { id: ex.id },
          data: { questionText: newQuestionText }
        });
        fixedCount++;
        console.log(`Fixed question ${ex.id} with ${matches.length} image(s).`);
      }
    }
  }
  console.log(`Fixed a total of ${fixedCount} questions containing missing images.`);
}

fixImages()
  .catch(console.error)
  .finally(() => prisma.$disconnect());