# Question Generation Process

This document outlines the architecture and flow for generating test-prep questions in the DEDP Study Platform.

## Overview
To provide a fast initial load time and prevent AI hallucinations or context window issues from bulk-generating too many questions at once, the system uses an **Iterative Background Generation** approach. 

When a user requests a study session (e.g., 20 questions), the system immediately starts the session using existing questions from the database, while the remaining missing questions are generated one-by-one in the background.

## 1. Initial Session Creation (`createStudySession`)
Located in `web/src/app/actions.ts`.
- When the user clicks "Start Session", the frontend calls `createStudySession`.
- The function queries the database for existing exercises matching the selected topics.
- It randomly shuffles these existing exercises and selects up to half of the user's requested count (to ensure a mix of old and new questions).
- It creates a `StudySession` record in the database with these initial exercises.
- It returns the session data, the initial exercises, and a `missingCount` (requested count minus existing count).

## 2. Background Generation Trigger (`StudyInterface.tsx`)
Located in `web/src/components/features/StudyInterface.tsx`.
- The UI immediately renders the study session using the initial batch of questions.
- A `useEffect` hook monitors the `missingCount`.
- If `missingCount > 0` and it is not currently generating (`!isGeneratingNext`), it locks the state and triggers `generateNextExercise`.
- As each new question is generated, it is appended to the `exercises` state array and `missingCount` is decremented, creating a seamless streaming effect.
- The UI displays a `Generating X more...` indicator. If the user reaches the end of the available questions before generation is complete, the "Next" button temporarily disables and shows a loading state.

## 3. Iterative Generation (`generateNextExercise`)
Located in `web/src/app/actions.ts`.
This server action is responsible for generating exactly ONE new exercise per call.

### Proportional Topic Selection
To ensure all selected topics are covered equally, the system does not pick topics randomly. It selects the next topic sequentially based on how many questions have already been assigned to the session:
```typescript
const targetTopicId = topicIds[existingExerciseIds.length % topicIds.length];
```
This guarantees that if the user selects 3 topics and asks for 9 questions, each topic will be the basis for exactly 3 questions.

### Context Gathering
The AI requires strong context to generate high-quality, relevant questions.
- **Topic Content:** The system fetches the content for the `targetTopicId`.
- **Week/Class Context:** It fetches all other topics that share the same `week` and `courseId`. This allows the AI to understand the broader context of the lesson sequence and interrelate concepts accurately.
- **Style Matching:** It fetches up to 5 existing exercises from the selected topics to provide as few-shot examples, ensuring the new question matches the expected difficulty and formatting.

### AI Generation
The system uses the Vercel AI SDK (`generateObject`) with Google's `gemini-3.6-flash` model.
- The prompt instructs the model to act as an MIT economics professor.
- It enforces that the new question MUST be completely self-contained (inventing hypothetical scenarios or data tables if necessary).
- It enforces strict JSON schema adherence (`z.object`) for the output structure (`questionText`, `exerciseType`, `choices`, `correctAnswer`, `explanation`).

### Persistence
- The new exercise is saved to the `Exercise` table in the database.
- The `StudySession` record is updated to append the new `exerciseId` to its `exerciseIds` JSON array.
- The new exercise object is returned to the frontend.

## Supported Question Types
The AI is instructed to generate one of the following types:
1. `single_choice`: Standard multiple choice.
2. `multiple_choice`: Multiple correct answers (checkboxes).
3. `numeric`: Requires a numeric input (evaluated with a 0.01 margin of error).
4. `dropdown`: Fill-in-the-blank style where the `questionText` contains a `[Dropdown X]` placeholder, and choices are mapped to a select input.

## LaTeX Processing
Generated questions often contain math formulas. 
- Inline math is typically generated as `\( ... \)`.
- Block math is generated as `\[ ... \]`.
The frontend `Flashcard` component intercepts these and runs `preprocessLaTeX` to convert them into standard markdown math delimiters (`$` and `$$`) before rendering them through `react-markdown` with `remark-math` and `rehype-katex`.