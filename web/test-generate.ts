import 'dotenv/config';
import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("Could not find GEMINI_API_KEY in environment");
  process.exit(1);
}

const google = createGoogleGenerativeAI({
  apiKey: apiKey,
});

async function run() {
  try {
    const { object } = await generateObject({
      model: google('gemini-3.6-flash'),
      prompt: 'Generate a single question about economics.',
      schema: z.object({
        question: z.string()
      })
    });
    console.log("Success gemini-3.6-flash:", object);
  } catch (e: any) {
    console.error("Error gemini-3.6-flash:", e.message);
  }
}
run();
