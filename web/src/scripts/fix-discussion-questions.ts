import 'dotenv/config'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';
import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { generateObject } from 'ai'
import { textModel } from '../lib/ai'
import { z } from 'zod'

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("=== DRY RUN: Testing Discussion-Only Questions Fix ===");
  console.log("Reading exercises from database... (No updates will be written)\n");

  const exercises = await prisma.exercise.findMany();
  let discussionCount = 0;

  for (const ex of exercises) {
    const explLower = (ex.explanation || "").toLowerCase();
    const isDiscussionOnly = explLower.includes("discussion purposes only") || 
                             explLower.includes("meant for discussion") ||
                             explLower.includes("is not graded");

    if (isDiscussionOnly) {
      discussionCount++;
      console.log(`[IDENTIFIED PLACEHOLDER] ID: "${ex.id}"`);
      console.log(`- Question Text: "${ex.questionText.trim().substring(0, 150)}..."`);
      console.log(`- Choices available: ${ex.choices}`);
      console.log(`- Current Placeholder Explanation: "${ex.explanation?.substring(0, 100)}..."`);

      try {
        const parsedChoices = JSON.parse(ex.choices);
        
        // Dry-run call to Gemini to generate the correct answers and brilliant socratic explanation
        const { object } = await generateObject({
          model: textModel(),
          schema: z.object({
            correctAnswer: z.string(),
            explanation: z.string()
          }),
          prompt: `You are an expert MIT economics and statistics professor.
The following question was parsed from an ungraded discussion-only slide on MITx. It is missing a valid, conceptually correct answer and a robust explanation because the current placeholder explanation simply says: "This question is meant for discussion...".

Your task is to analyze the question and its choices, select the mathematically/conceptually correct choice, and write a thorough, crystal-clear explanation for why it is correct based on rigorous economic and statistical theories.

Question:
"${ex.questionText}"

Choices:
${parsedChoices.map((c: string, idx: number) => `${idx + 1}. ${c}`).join('\n')}

Underlying Context/Hints:
- If the question asks about the Central Limit Theorem (CLT) and skewness: Explain how the sampling distribution of the mean approaches normality as n increases (n >= 30), but remains skewed/non-normal for small sample sizes if the parent population is skewed. Therefore, the statement "The sampling distribution may not be normal if the parent population is skewed" is True because of the small-sample case!
- Always be encouraging, socratic, and write a premium academic-grade explanation.
- Return the exact string of the correct choice matching one of the options in the choices array.`
        });

        console.log(`- Proposed Correct Option: "${object.correctAnswer}"`);
        console.log(`- Proposed New Explanation: "${object.explanation.substring(0, 250)}..."`);
      } catch (e: any) {
        console.log(`- [Error generating dry-run fix]: ${e.message}`);
      }
      console.log("-".repeat(80));
    }
  }

  console.log(`\n=== DRY RUN RESULTS ===`);
  console.log(`Total checked exercises in DB: ${exercises.length}`);
  console.log(`Discussion placeholder exercises identified: ${discussionCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
