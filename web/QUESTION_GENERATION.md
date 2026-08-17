# Question Generation, Adaptive Ingestion & Diagnostic Architecture

This document outlines the end-to-end architecture, database schema integrations, and algorithmic designs for study session generation, contextual enrichment, exam simulation, diagnostic report compilation, and socratic curriculum planning in the DEDP Study Platform.

---

## Architecture Overview

The DEDP Study Platform has evolved from a simple textbook static study aid into a highly personalized, adaptive educational workspace. Rather than overwhelming students with passive, cookie-cutter content, the platform relies on **Iterative Background Generation**, **Adaptive Sourcing Pools**, **Automated Context Enrichment**, **Graded Mock Exam Simulation**, and **Generative Academic Diagnosis**.

```
                           +----------------------------------------+
                           |       Socratic Study Chatbot           |
                           |   Conversational Planning / Advising   |
                           +-------------------+--------------------+
                                               |
                                               v (Gemini Object Compiler)
                           +-------------------+--------------------+
                           |        Structured Study Plan           |
                           |   Chronological multi-session timeline |
                           +-------------------+--------------------+
                                               |
                                               v (Deployed to SQLite)
                           +-------------------+--------------------+
                           |             Active Study Session       |
                           |  Study / Exam mode, Sourcing Mix, Timer |
                           +---------+--------------------+---------+
                                     |                    |
       (Adaptive Database Pulls)     |                    |   (Background AI Generator)
       - Weak Areas (Remediation)    v                    v   - Proportional Topic selection
       - Unstudied Content Topics  +---+                +---+ - Context & Few-shot matching
       - Expert Level Reviews      |DB |                |AI | - Schema-strict outputs
                                   +---+                +---+
                                     |                    |
                                     +---------+----------+
                                               |
                                               v
                           +-------------------+--------------------+
                           |        Automatic Context Enrichment    |
                           |  - Transcripts & keyword-based fallback|
                           |  - Dynamic markdown table builder      |
                           +-------------------+--------------------+
                                               |
                                               v
                           +-------------------+--------------------+
                           |          Mock Exam Simulator           |
                           |  - Non-leaking draft answer persistence|
                           |  - Proportional partial-credit grader  |
                           +-------------------+--------------------+
                                               |
                                               v
                           +-------------------+--------------------+
                           |         Academic Diagnostic Engine     |
                           | - Cognitive traps & mistake analyses   |
                           | - Clickable review anchors to source   |
                           +----------------------------------------+
```

---

## 1. Adaptive Sourcing & Smart Selection (`createStudySession`)

When a student initiates a study session or mock exam, the platform does not rely on simple random selection. Instead, it utilizes an adaptive, multi-bucket selection algorithm in `src/app/actions.ts` designed to target a student's precise learning needs.

### Sourcing Buckets & Weights
The selection engine partitions the requested question pool using three performance-based buckets:
1. **Weak Areas Bucket (`weakPct`, Default 60%)**: Prioritizes topics where the student's historical accuracy is below 70%, ensuring critical remediation of foundational concepts.
2. **Unstudied Content Bucket (`unstudiedPct`, Default 20%)**: Pulls topics the student has not yet attempted to expand syllabus coverage and avoid blindspots.
3. **Expert Review Bucket (`expertPct`, Default 20%)**: Re-evaluates topics where the student has high proficiency (Accuracy >= 70%) to combat learning decay via Spaced Repetition.

### Sourcing Mix (AI vs. Database)
The selection engine supports a sliding scale `sourcingMix` parameter (0% to 100%):
- **Database Questions**: Sourced directly from historical exercises and past crawls.
- **AI-Generated Questions**: If the database does not contain enough exercises to fulfill a topic's target count (or if the `sourcingMix` dictates), the platform enters **Iterative Background Generation**.

---

## 2. Iterative Background Generation (`generateNextExercise`)

To maintain blazing-fast page loads and optimize API tokens, the platform generates missing questions one-by-one in the background as the user studies.

### Core Mechanics
1. **Proportional Topic Coverage**: The generator avoids topic clustering. It distributes coverage sequentially based on the session's active topic list:
   ```typescript
   const targetTopicId = topicIds[existingExerciseIds.length % topicIds.length];
   ```
2. **Few-Shot Prompt Injector**: To ensure difficulty consistency and stylistic cohesion, the generator fetches up to 5 existing exercises from the selected topics to provide as few-shot exemplars to the LLM.
3. **Structured Schema Constraints**: Using Vercel AI SDK and Gemini's structured outputs (`generateObject`), questions are compiled with strict JSON schema constraints validating `questionText`, `choices`, `correctAnswer`, and `explanation` properties.

---

## 3. Dynamic Context Enrichment & Table Reconstruction

Economic study questions are often highly dependent on real-world case studies, regression estimates, or specific policy parameters that may not be fully represented in the question text. The enrichment pipeline (`enrichExerciseWithContext`) runs right before a question is rendered to address this issue.

### Highest Local Fidelity Fallback
The engine searches for grounding context in three descending tiers:
1. **Direct Lecture Transcripts**: Queries the preceding lecture transcripts matching the specific topic class name.
2. **Global Course Context (`getGlobalCourseContext`)**: Scans the question text for key academic authors, studies, or policies (e.g., *Olken*, *Acemoglu & Robinson*, *Duflo*, *Ferraz & Finan*, *corruption*, *vote-buying*, *titling*, *deworming*, *Gini*). It searches all course-wide topics matching these keywords to isolate relevant research setups.
3. **Surrounding Week Context**: Pulls other topics sharing the same week and course to reconstruct surrounding lesson sequence metadata.

### Dynamic Markdown Table Reconstruction
If the grounding transcript describes regression results, statistical parameters, or survey discrepancies, and the question refers to a Table (e.g., "Table 1", "according to the table"), the enrichment prompt instructs the model to construct a clean Markdown table representing those values directly inside the question. This restores missing visual tables that cannot be represented in plain crawled text.

### Neutrality Guarantee
The context enrichment prompt strictly enforces that the generated context **MUST NOT** hint at, rule out, or define the correct answer. It must remain objective and neutral, only restoring the case setup context.

---

## 4. Mock Exam Simulation & Graded Metrics

In addition to standard self-paced study sessions, the platform includes a fully-featured, timed **Exam Mode** providing rigorous grading constraints mimicking university exams.

### Draft Answers & Flagging
- **Answer Hiding**: Correct answers and professor explanations are completely hidden during an active exam.
- **Draft Persistence**: Draft answers are saved and updated inside the `StudySession.draftAnswers` column, allowing students to navigate backward and forward, changing responses before submission.
- **Flag for Review**: In exam mode, a "Flag for Review" toggle appears, enabling students to bookmark difficult questions (saved in `StudySession.flaggedIds` as a JSON list) to easily return to them.

### Proportional Partial-Credit Scoring
To prevent students from cheating by selecting all checkboxes in `multiple_choice` questions, the grading engine applies a strict **one wrong cancels one right** proportional credit formula:

$$\text{Net Score} = \max\left(0, \frac{\text{Selected Correct Options} - \text{Selected Incorrect Options}}{\text{Total Correct Options}}\right)$$

### Validation Standards
- **Numeric Exercises**: Numeric inputs are validated under a strict floating-point margin of error of $\pm 0.01$.
- **Dropdown Exercises**: Dropdown questions contain a `[Dropdown 1]` placeholder in the question text. The validator cleans expected and user responses by stripping index labels, escaping LaTeX backslashes, normalizing capitalization, and performing strict set-to-set matching.

---

## 5. Professor Diagnosis Engines

Once a student completes a session, they receive an immediate academic diagnostics report generated by the AI acting as an elite MIT economics professor.

### Exam-Level Diagnostics (`generateExamDiagnosis`)
Reviews the completed exam session and builds a markdown report featuring:
1. **Executive Performance Summary**: High-level analysis of their strengths and immediate gaps.
2. **Topic Mastery Matrix**: Places topics into "High Mastery" ($\ge 80\%$), "Developing Mastery" ($50\% - 79\%$), and "Critical Remediation" ($< 50\%$).
3. **Cognitive Trap Identification**: Explains the precise economic or statistical mistakes made (e.g., *confusing correlation with causality*, *first-order condition mathematical errors*, *understanding clustered standard errors*).

### Global Diagnostics (`generateGlobalDiagnosis`)
Aggregates all historical performance logs across both MITx courses (14.750x and JPAL102x) to compile a holistic study advisory:
- Generates a multi-level mastery heatmap.
- Identifies the top 4 weakest topics, fetches their source transcript content, and performs deep error deconstructions.

### Clickable Review Anchors
The diagnosis engines output a tailored remedial study checklist. Each task includes a direct clickable Markdown link that opens the exact local file inside the platform visualizer:
- **PDF Slides**: Maps concepts to estimated slide numbers:
  `[Source Slides](/api/file?path=URL_ENCODED_LOCAL_PATH#page=SLIDE_NUMBER)`
- **Lecture Transcripts**: Extracts a unique 5-10 word quote from the lesson text to highlight for the student:
  `[Source Transcript](/api/file?path=URL_ENCODED_LOCAL_PATH&highlight=SHORT_UNIQUE_QUOTE)`

---

## 6. Socratic Study Plan Creator & Timeline Scheduler

The platform provides a collaborative study workspace where students discuss their schedule constraints, weak areas, and preparation window with a socratic professor chat interface.

1. **Socratic Planner Chatbot (`generatePlannerResponse`)**: An AI counselor that analyzes student study habits, challenges aggressive cramming timelines by raising trade-offs, and emphasizes active recall over passive reading.
2. **Structured Study Plan Compiler (`generateStructuredStudyPlan`)**: Translates the chat logs and historical performance stats into a highly tailored, multi-day structured JSON curriculum map. It maps focus descriptions to correct database topic IDs and structures pre-configured mock exam slots on final prep days.
3. **Automated Database Deployment (`saveAndDeployStudyPlan`)**: Instantly creates a cascading `StudyPlan` record and automatically pre-provisions and seeds the corresponding `StudySession` slots with exercises.

---

## 7. Performance Tracking (Micro, Meso, Macroscopic Analytics)

To visualize a student's learning trajectory, the platform queries all completed `ExerciseLog` records over time and groups them into three distinct cognitive resolutions:

- **Macroscopic Level (Course-wide)**: Tracks overall performance in MIT 14.750x (Political Economy) vs. JPAL102x (Data and Policy Design).
- **Mesoscopic Level (Week-by-Week)**: Tracks performance across individual course modules and lectures.
- **Microscopic Level (Topic-by-Topic)**: Tracks detailed accuracy and coverage statistics for individual learning units.

This data is flattened into date-based timelines and plotted inside the visual **Analytics Dashboard** to show a live representation of learning growth and conceptual mastery.

---

## 8. Supported Question Types Reference

| Exercise Type | Input UI Element | Validation Algorithm | Example Formatting |
| :--- | :--- | :--- | :--- |
| **`single_choice`** | Radio Buttons | Direct matching with correct option. | `Choices: ["Option A", "Option B", ...]` |
| **`multiple_choice`** | Checkboxes | Net proportional matching (one wrong cancels one right). | `CorrectAnswer: "[\"Option A\",\"Option C\"]"` |
| **`numeric`** | Number Input | Margin of error $\le 0.01$ of target decimal value. | `CorrectAnswer: "0.80"` |
| **`dropdown`** | Inline `<select>` | Set comparison, lowercase, prefix & LaTeX normalized. | `QuestionText: "The effect is [Dropdown 1]."` |

---

## 9. Math & LaTeX Rendering Pipeline

To ensure beautiful math formulas are rendered perfectly, the platform uses a hybrid processing pipeline:
1. **Standard Formats**: AI is prompted to output standard LaTeX formulas using `\( ... \)` for inline math and `\[ ... \]` for block equations.
2. **Preprocessing**: The `preprocessLaTeX` hook cleans alternative symbols or unescaped values and maps them into standard markdown math delimiters (`$` and `$$`).
3. **HTML Rendering**: The frontend parses these markers using `react-markdown` alongside the `remark-math` and `rehype-katex` plugins, converting formulas into crisp, vector-rendered mathematical typography on the page.
