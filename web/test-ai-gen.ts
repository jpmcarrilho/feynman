import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';
import { createStudySession } from './src/app/actions';

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function run() {
  try {
    const topic = await prisma.topic.findFirst();
    if (!topic) throw new Error("No topics found");

    console.log("Found topic:", topic.id);
    // Request 50 exercises to force AI generation (since a topic rarely has 50 built-in exercises)
    const res = await createStudySession([topic.id], 50);
    console.log("Success generated count:", res.exercises.length);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await prisma.$disconnect();
  }
}
run();