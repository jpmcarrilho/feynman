import { describe, it, expect } from 'vitest';
import { parseExerciseBlock, parseLessonContent } from './ingest';

describe('ingest service', () => {
  it('parses an exercise block correctly', () => {
    const exerciseText = `Question: What is 2 + 2?
- [ ] 3
- [x] 4
- [ ] 5
Explanation: 2 + 2 equals 4.`;

    const parsed = parseExerciseBlock(exerciseText);
    expect(parsed.questionText).toContain('What is 2 + 2?');
    expect(parsed.choices.length).toBe(3);
    expect(parsed.choices[0]).toBe('3');
    expect(parsed.correctAnswer).toBe('4');
    expect(parsed.explanation).toContain('2 + 2 equals 4.');
  });

  it('parses an exercise block without explanation', () => {
    const exerciseText = `Question: Is the sky blue?
- [x] Yes
- [ ] No`;

    const parsed = parseExerciseBlock(exerciseText);
    expect(parsed.questionText).toContain('Is the sky blue?');
    expect(parsed.choices.length).toBe(2);
    expect(parsed.correctAnswer).toBe('Yes');
    expect(parsed.explanation).toBeUndefined();
  });

  it('parses a full lesson file', () => {
    const fileContent = `URL: https://example.com/lecture1

[TRANSCRIPT]
Hello world.
==================
[EXERCISE/PROBLEM]
Question 1?
- [x] Yes
- [ ] No
==================`;

    const parsed = parseLessonContent(fileContent);
    expect(parsed.url).toBe('https://example.com/lecture1');
    expect(parsed.transcript).toBe('Hello world.');
    expect(parsed.exercises.length).toBe(1);
    expect(parsed.exercises[0].correctAnswer).toBe('Yes');
  });
});
