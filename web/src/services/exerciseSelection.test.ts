import { describe, it, expect } from 'vitest';
import { selectNextExercise } from './exerciseSelection';
import type { Exercise, ExerciseLog } from '@prisma/client';

describe('exerciseSelectionService', () => {
  it('prioritizes exercises with lower correctness rates', () => {
    const exercises = [
      { id: 'ex1', topicId: 't1' },
      { id: 'ex2', topicId: 't1' },
      { id: 'ex3', topicId: 't1' }
    ] as Exercise[];

    // ex1: 100% correct, ex2: 0% correct, ex3: 50% correct
    const logs = [
      { exerciseId: 'ex1', isCorrect: true },
      { exerciseId: 'ex2', isCorrect: false },
      { exerciseId: 'ex3', isCorrect: true },
      { exerciseId: 'ex3', isCorrect: false },
    ] as ExerciseLog[];

    // Select multiple times to see the distribution
    const selections = { ex1: 0, ex2: 0, ex3: 0 };
    for (let i = 0; i < 100; i++) {
      const selected = selectNextExercise(exercises, logs);
      if (selected) selections[selected.id as keyof typeof selections]++;
    }

    // ex2 (0%) should be selected most often, followed by ex3 (50%), then ex1 (100%)
    expect(selections.ex2).toBeGreaterThan(selections.ex1);
    expect(selections.ex3).toBeGreaterThan(selections.ex1);
  });

  it('selects unseen exercises if all existing have high correctness', () => {
    const exercises = [
      { id: 'ex1', topicId: 't1' },
      { id: 'ex2', topicId: 't1' }
    ] as Exercise[];

    const logs = [
      { exerciseId: 'ex1', isCorrect: true },
    ] as ExerciseLog[];

    // ex2 is unseen, ex1 is 100% correct
    const selections = { ex1: 0, ex2: 0 };
    for (let i = 0; i < 100; i++) {
      const selected = selectNextExercise(exercises, logs);
      if (selected) selections[selected.id as keyof typeof selections]++;
    }

    expect(selections.ex2).toBeGreaterThan(selections.ex1);
  });
});
