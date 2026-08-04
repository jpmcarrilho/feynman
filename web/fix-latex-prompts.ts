import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function fixLatexPrompts() {
  const exercises = await prisma.exercise.findMany();
  let fixedCount = 0;

  for (const ex of exercises) {
    if (!ex.questionText) continue;

    let newQuestionText = ex.questionText;

    // Fix the Dell, Jones, and Olken formulas
    if (newQuestionText.includes('g_{crt} = alpha_c + gamma_{rt} + beta * TEMP_{crt} + tau * (TEMP_{crt} * POOR_c) + eps_{crt}')) {
      newQuestionText = newQuestionText.replace(
        /g_\{crt\} = alpha_c \+ gamma_\{rt\} \+ beta \* TEMP_\{crt\} \+ tau \* \(TEMP_\{crt\} \* POOR_c\) \+ eps_\{crt\}/g,
        '\\( g_{crt} = \\alpha_c + \\gamma_{rt} + \\beta \\times TEMP_{crt} + \\tau \\times (TEMP_{crt} \\times POOR_c) + \\epsilon_{crt} \\)'
      );
    }
    
    // Also replace standalone variables if they appear, but safely
    if (newQuestionText.includes('POOR_c')) {
       // Replace POOR_c not already in \( ... \)
       // It's easier to just replace all and then cleanup double escapes
       newQuestionText = newQuestionText.replace(/POOR_c/g, '\\( POOR_c \\)');
       // cleanup double wrapped
       newQuestionText = newQuestionText.replace(/\\\( \\\( POOR_c \\\) \\\)/g, '\\( POOR_c \\)');
       newQuestionText = newQuestionText.replace(/\\\( (.*?) \\\( POOR_c \\\) (.*?) \\\)/g, '\\( $1 POOR_c $2 \\)');
    }

    if (newQuestionText.includes(' tau ')) {
        newQuestionText = newQuestionText.replace(/ tau /g, ' \\( \\tau \\) ');
    }

    if (newQuestionText !== ex.questionText) {
      await prisma.exercise.update({
        where: { id: ex.id },
        data: { questionText: newQuestionText }
      });
      fixedCount++;
      console.log(`Fixed question ${ex.id}\nOLD: ${ex.questionText}\nNEW: ${newQuestionText}\n`);
    }
  }
  console.log(`Fixed a total of ${fixedCount} question prompts.`);
}

fixLatexPrompts()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
