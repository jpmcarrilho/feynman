import 'dotenv/config';
import { createStudySession } from './src/app/actions';

async function run() {
  try {
    const res = await createStudySession([], 1);
    console.log("Success:", res.exercises.length);
  } catch (e) {
    console.error("Error:", e);
  }
}
run();
