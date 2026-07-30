import type { Exercise, ExerciseLog } from '@prisma/client';

export function selectNextExercise(exercises: Exercise[], logs: ExerciseLog[]): Exercise | null {
  if (exercises.length === 0) return null;

  // Calculate weights based on correctness rate and seen status
  const weights = exercises.map(ex => {
    const exLogs = logs.filter(l => l.exerciseId === ex.id);
    if (exLogs.length === 0) {
      return { exercise: ex, weight: 1.0 }; // Unseen exercise
    }

    const correctCount = exLogs.filter(l => l.isCorrect).length;
    const correctnessRate = correctCount / exLogs.length;

    // Weight formula: (1 - correctnessRate) + 0.1 (baseline to ensure it can still be picked)
    let weight = (1 - correctnessRate) + 0.1;
    
    // Penalize recently seen (not fully implemented in this simple version, but could use timestamp)
    return { exercise: ex, weight };
  });

  // Calculate total weight
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);

  // Random selection based on weights
  let randomValue = Math.random() * totalWeight;
  for (const w of weights) {
    if (randomValue < w.weight) {
      return w.exercise;
    }
    randomValue -= w.weight;
  }

  // Fallback (should theoretically not be reached if weights > 0)
  return exercises[0];
}
