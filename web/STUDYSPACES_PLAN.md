# Studyspaces Implementation Plan

Branch: `feature/studyspaces` (repo root `/Users/joaopedromegidcarrilho/Documents/development/dedp`, app in `web/`).
Audience: implementer models working from this document alone. All paths below are relative to `web/` unless they start with `/`.

---

## 0. Execution model (read first)

- All work happens on the single existing branch `feature/studyspaces`. No other branches, no worktrees, no concurrent implementers.
- Tasks run strictly one at a time in the order of section 6. A task starts only after the previous task's verification passed and its commit exists.
- Every task leaves the app building and usable. After every task the two existing MIT courses (14.750x, JPAL102x) must still open, start a study session, generate a question and show the visualizer.
- One commit per task, using the suggested commit message (end it with the attribution line the session requires). Run `git status` and `git diff --stat` before committing; never commit `dev.db`, `storage/`, `backups/`, `.env*`.
- Do not run `scripts/launchd/install.sh` and do not install Tailscale. Those are owner steps (section 9).
- `AGENTS.md` says this Next.js version (16.2.12) has breaking changes. After task T01 installs dependencies, read the relevant file in `node_modules/next/dist/docs/` before using any Next API in a task. Section 8 lists the APIs this plan relies on and how far each was confirmed.
- Auth: from T04 on, every exported server action (existing and new) starts with `await requireAuth()` (`src/server/auth.ts`, throws `Error('Unauthorized')` when `checkIsAuthenticated()` is false), except `loginWithPasscode`, `logout` and `checkIsAuthenticated` themselves. Every route handler returns 401 when unauthenticated. A test (`src/app/actions.auth.test.ts`, T04) calls every export of each `'use server'` module with auth mocked to false and expects a rejection; new action modules are added to that test in the task that creates them.

---

## 1. Context and decisions (compact)

The app is a single-user "Feynman" Socratic tutor built around two pre-crawled MIT courses. The goal is to generalize it into **studyspaces**: the user creates a space, uploads `.txt`, `.md`, `.pdf` files, the app builds an outline, proposes a tutor persona, and runs the existing study loop scoped to that space. The phone reaches the Mac over Tailscale.

Fixed decisions (do not reopen):

1. Local-first, single user, no accounts, no user model. SQLite stays. Uploaded files live in a local folder next to the database (`web/storage/`). No cloud storage, no storage abstraction. Gemini stays the AI backend.
2. The passcode gate (`src/app/auth-actions.ts`) stays as is.
3. Studyspace = existing `Course` model (UI label "Studyspace"). Add `profile` (JSON string) and `createdAt`. New `Source` model per uploaded file. `Topic` gains `sourceId`, `order`, `summary`, `keyTerms`, `isQuantitative`. `StudySession` and `StudyPlan` gain `courseId`. `week` column stays, UI label "Module".
4. Upload pipeline: upload → extract (text directly; PDFs page by page; Gemini native PDF input when extracted text is too sparse) → LLM segmentation into modules/topics (title, page range, summary, key terms, isQuantitative) → import questions already in the file → pre-generate a few starter exercises per topic → pollable status with failure reasons.
5. Tutor persona: one structured LLM call after every file in the first upload bundle finished extraction and segmentation. Input: combined outline + short samples per file. Output `TutorProfile` (subject, level, one-line identity, tone, analogy domains, quantitative flag + question-type mix, content language, sample explanation). Editable card with Regenerate and presets (Socratic professor, patient coach, exam driller). Failed files are left out and named. Two unrelated subjects → say so, offer to split into two spaces. Feynman method is fixed product behavior; the persona varies only expertise, level, tone, language. Later uploads only produce a "suggested update" the user accepts or ignores.
6. All text prompts and the voice system instruction are built from the profile in one prompts module. Keyword list → search over Topic content + `keyTerms` (FTS5 rejected, see 3.6). Week-number logic → `isQuantitative`. Outline JSON file → `Topic.order`. "Comprehensive review" calibration becomes optional (`profile.calibrationModule`). The two MIT courses keep working via backfilled profiles.
7. Navigation: after login `/spaces` (list + "New studyspace" card); wizard (name and goal → drop files → processing → outline review with rename/merge/reorder → persona card → start first session); study interface at `/spaces/[id]`, all queries scoped to that space.
8. Files served by `Source` id or `Topic` id, summaries by constrained key; never by arbitrary path. Existing topics with absolute `localPath` keep opening.
9. Phone access: production build under a launchd user agent (restart on crash), plist + install/uninstall scripts the OWNER runs. "Phone access" toggle starts/stops `tailscale serve` for the app port, shows status (on / off / Tailscale not running) and the HTTPS ts.net URL as QR. Toggle works only for requests from the Mac itself. Web app manifest. Remove the ngrok origin once phone access works.

Out of scope: accounts, `deploy-cloud-run.js`, embeddings/GraphRAG, changing the adaptive selection algorithm (`createStudySession` bucket logic), the "10x" items in `REFACTOR_PLAN.md`, refactors not needed here.

---

## 2. Verified facts about the current code (2026-11-10)

- `web/node_modules` does not exist at all (not only `next`). Nothing can build or test until T01.
- `zod` is imported in `src/app/actions.ts` but is not in `package.json` (it resolves transitively). T01 adds it explicitly.
- `.env` has `DATABASE_URL="file:./dev.db"`; `src/lib/db.ts` uses `PrismaBetterSqlite3({ url: process.env.DATABASE_URL || 'file:./dev.db' })`. `prisma.config.ts` already points `migrations.path` at `prisma/migrations` (folder absent). `prisma/dev.db` is an empty 0-byte file (ignore it).
- DB (`dev.db`, 133 MB, journal mode `delete`): 2 courses (`Course.title` equals `code`, description "Auto-generated course for …"), 1,322 topics (376 / 946), 1,172 exercises (34 `gen-`), 31 sessions, **0 study plans**, 737 logs, max topic content 830,003 chars, total content ~6.5 M chars, 40 topics with empty content. Topic `week` values look like `Week_06_Sampling_and_Sample_Size`, `Week_13_Comprehensive_Review`, `Week_16_Comprehensive_Review`.
- Session/course span: every session with logs maps to exactly one course (checked by joining logs → exercise → topic). 3 sessions have no logs; one of them is the `mode = 'global_diagnosis'` row titled "Global AI Learning Diagnosis".
- System `sqlite3` 3.54 has FTS5 compiled in.
- `MIT_Learn_Courses/<code>_outline.json` exists for both courses: array of `{ sectionTitle, links: [{ text, href }] }`; `links[].text` matches `Topic.className`.
- Week summaries are written to `summaries/<courseCode>/<weekSlug>.md` and session index files to `summaries/session_<sessionId>_index.md`. **34 files under `web/summaries` are tracked in git.**
- `/api/file?path=` links are parsed in `StudyInterface.handleViewFile` (~line 484), fetched in its `activeFile` effect (~546), rendered by `SideVisualizer.tsx` (~123, ~140), `VoiceHub.tsx` (~135); produced by `ResourcesDashboard.tsx` (~72), `summaryService.ts` (~157), prompts in `actions.ts` (~1263, ~1403) and the voice context in `StudyInterface.tsx` (~920).
- `useLiveAPI(systemInstructionText)` (`src/hooks/useLiveAPI.ts`) takes the instruction as a string; the live model id is `models/gemini-3.1-flash-live-preview`.
- localStorage key for the active session: `dedp_active_session` (StudyInterface).
- `ConfigureSessionDialog` filters Course → Week → Class → Unit and has question-count options "32 (14.750x Final)" and "53 (JPAL102x Final)" (~188).
- Tests are colocated (`src/app/actions.test.ts`, `src/services/*.test.ts`, `src/components/features/*.test.tsx`), vitest with jsdom and the `@` alias. Existing tests mock `ai`, `@ai-sdk/google`, `@/lib/db`, `fs`. New tests follow the same colocated placement.
- No `middleware.ts`/`proxy.ts`/`instrumentation.ts` exists.
- Review findings checked on 2026-11-10 (all confirmed unless noted): `getSessionHistory` and `getStudyPlans` return full session rows incl. `chatLog` (27 sessions hold 28.4 MB of chat logs; `getStudyPlans` returns nothing today because there are 0 plans); `createStudySession`/`getSessionWithExercises` include full `topic` rows with `content`; the voice context effect (StudyInterface ~910–951) re-sends every topic of the class including "Exercise Content & Solutions" topics whenever `session` changes; `useLiveAPI.sendText` (~341) stops audio and appends the text to `messages`; no action in `actions.ts` checks auth; the Gemini API key is returned to the browser by `getGeminiApiKey` (auth-actions.ts ~59) and put in the WebSocket URL (useLiveAPI ~207–210); nothing in `src/` or the config files references `NEXT_PUBLIC_GEMINI_API_KEY`; `handleFinishExam` sets the diagnosis content but not `activeFile`, so the visualizer (rendered only when `activeFile` is set, ~1729) never opens; "Cancel Exam" calls `handleFinishSession` (~1188) and marks the exam completed; the survey text filter (actions.ts ~355) excludes 132 exercises; `ExerciseLog` foreign keys are `ON DELETE RESTRICT`, so deleting a plan whose sessions have logs fails if SQLite foreign keys are enforced by the adapter (not verified, U13) and orphans logs otherwise; the only indexes are primary keys and `Course.code`; there are 2 duplicate `(sessionId, exerciseId)` log pairs (3 surplus rows); `draftAnswers`/`flaggedIds` are never written (0 rows); duration is hard-coded to 30 (StudyInterface ~750, ~900); three graders disagree (Flashcard ~87–155 exact-set for multi-select, StudyInterface ~655–751 marks multi-select correct at partial score ≥ 0.5, actions.ts ~1102–1187 proportional score); numeric tolerance is absolute 0.01 everywhere; enrichment has rewritten 469 of 1,172 questions in place with an in-band `<!-- enriched -->` marker; `explainMistake` is exported but never called.
- Node is v22.14.0 from nvm (`~/.nvm/versions/node/v22.14.0/bin/node`); arch arm64.
- `.env` contains `NEXT_PUBLIC_GEMINI_API_KEY`. No code references it, so it is not in any bundle today; the owner should delete it from `.env` (section 9).

Corrections to the brief's findings: `StudyPlan` has 0 rows (only sessions need a course backfill); `node_modules` is missing entirely, not just `next`; `zod` is undeclared; `Course.title` is just the code; the summaries folder is tracked in git.

---

## 3. Data model

### 3.1 Target `prisma/schema.prisma`

All schema changes of this plan (studyspaces, indexes, delete rules, session state, exercise quality fields) are applied in ONE migration in T02, because SQLite redefines a table for every foreign-key or constraint change and doing it once is safer. Code starts using the new columns in later tasks. Additions are marked `// NEW`.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
}

model Course {
  id                String         @id @default(uuid())
  code              String         @unique
  title             String
  description       String?
  profile           String?        // NEW: JSON TutorProfile (accepted persona); null until accepted
  profileSuggestion String?        // NEW: JSON ProfileSuggestion (initial proposal or "suggested update")
  goal              String?        // NEW: free text from the wizard
  starterStatus     String?        // NEW: null | "waiting_for_profile" | "pending" | "running" | "done" | "failed" (starter exercises for a new space, 4.6)
  createdAt         DateTime       @default(now())   // NEW
  topics            Topic[]
  sources           Source[]       // NEW
  sessions          StudySession[] // NEW
  plans             StudyPlan[]    // NEW
}

model Source {                                        // NEW
  id              String    @id @default(uuid())
  courseId        String
  originalName    String
  mimeType        String
  sizeBytes       Int
  storageKey      String    // relative to STORAGE_DIR, e.g. "sources/<courseId>/<sourceId>/original.pdf"
  bundle          String    @default("initial") // "initial" | "later"
  status          String    @default("uploaded") // see 4.2
  failedStage     String?
  error           String?
  warning         String?
  pageCount       Int?
  charCount       Int?
  usedOcrFallback Boolean   @default(false)
  leaseExpiresAt  DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  course          Course    @relation(fields: [courseId], references: [id], onDelete: Cascade)
  topics          Topic[]

  @@index([courseId])
}

model Topic {
  id             String     @id @default(uuid())
  courseId       String
  sourceId       String?    // NEW
  order          Int        @default(0)  // NEW: global order inside the course
  week           String?    // UI label "Module"
  className      String?
  unit           String?
  title          String
  resourceType   String?
  content        String?
  localPath      String?
  summary        String?    // NEW
  keyTerms       String?    // NEW: JSON string[]
  isQuantitative Boolean    @default(false) // NEW
  pageStart      Int?       // NEW
  pageEnd        Int?       // NEW

  course         Course     @relation(fields: [courseId], references: [id], onDelete: Cascade)   // NEW delete rule
  source         Source?    @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  exercises      Exercise[]

  @@index([courseId, order])
  @@index([courseId, week])  // NEW
  @@index([sourceId])
}

model Exercise {
  id                   String        @id @default(uuid())
  topicId              String
  questionText         String
  exerciseType         String        @default("single_choice")
  choices              String
  correctAnswer        String
  explanation          String?
  isGraded             Boolean       @default(true)       // NEW: false for surveys/feedback/participation items (replaces the text filter)
  origin               String        @default("imported") // NEW: "imported" | "generated" | "starter"
  status               String        @default("active")   // NEW: "active" | "rejected" | "reported" | "retired"
  promptVersion        String?       // NEW: prompt version that generated it
  originalQuestionText String?       // NEW: text before enrichment
  enrichedAt           DateTime?     // NEW: replaces the "<!-- enriched -->" marker
  reportedReason       String?       // NEW
  createdAt            DateTime      @default(now())      // NEW
  topic                Topic         @relation(fields: [topicId], references: [id], onDelete: Cascade) // NEW delete rule
  logs                 ExerciseLog[]
  sessionItems         SessionExercise[] // NEW

  @@index([topicId]) // NEW
}

model StudySession {
  id              String        @id @default(uuid())
  courseId        String?       // NEW (nullable for legacy rows)
  title           String?
  startTime       DateTime      @default(now())
  endTime         DateTime?
  status          String        // "active" | "completed" | "cancelled" (NEW value)
  mode            String        @default("study")
  timeLimit       Int?
  draftAnswers    String?       // legacy, unused (0 rows hold data); kept to avoid scope creep
  flaggedIds      String?       // legacy, unused
  sourcingMix     Int           @default(50)
  diagnosis       String?
  chatLog         String?
  exerciseIds     String?       // legacy; replaced by SessionExercise from T17 on, no longer written after T17
  studyPlanId     String?
  topicIds        String?       // NEW: JSON string[] selected when the session started
  targetCount     Int?          // NEW: requested question count
  deadline        DateTime?     // NEW: exam end time (server-authoritative timer)
  currentPosition Int           @default(0) // NEW: resume point
  course          Course?       @relation(fields: [courseId], references: [id], onDelete: Cascade) // NEW
  studyPlan       StudyPlan?    @relation(fields: [studyPlanId], references: [id], onDelete: Cascade)
  logs            ExerciseLog[]
  items           SessionExercise[] // NEW

  @@index([courseId, startTime])
}

model SessionExercise {                                  // NEW
  id           String       @id @default(uuid())
  sessionId    String
  exerciseId   String
  position     Int
  draftAnswer  String?
  flagged      Boolean      @default(false)
  timeSpentSec Int          @default(0)
  session      StudySession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  exercise     Exercise     @relation(fields: [exerciseId], references: [id], onDelete: Cascade)

  @@unique([sessionId, exerciseId])
  @@unique([sessionId, position])
  @@index([exerciseId])
}

model StudyPlan {
  id               String         @id @default(uuid())
  courseId         String?        // NEW
  title            String
  executiveSummary String
  status           String         @default("active")
  createdAt        DateTime       @default(now())
  updatedAt        DateTime       @updatedAt
  course           Course?        @relation(fields: [courseId], references: [id], onDelete: Cascade) // NEW
  sessions         StudySession[]
}

model ExerciseLog {
  id         String       @id @default(uuid())
  sessionId  String
  exerciseId String
  isCorrect  Boolean
  score      Float?       // NEW: 0..1 partial credit from gradeAnswer()
  assisted   Boolean      @default(false) // NEW: tutor was asked before answering
  userAnswer String?
  duration   Int          // seconds; real visible time from T18 on
  timestamp  DateTime     @default(now())
  session    StudySession @relation(fields: [sessionId], references: [id], onDelete: Cascade) // NEW delete rule (was RESTRICT)
  exercise   Exercise     @relation(fields: [exerciseId], references: [id], onDelete: Cascade) // NEW delete rule (was RESTRICT)

  @@unique([sessionId, exerciseId]) // NEW: also serves lookups by sessionId
  @@index([exerciseId])             // NEW
}
```

Notes:
- `pageStart`/`pageEnd`, `goal`, `profileSuggestion`, `starterStatus`, `bundle`, `warning`, `leaseExpiresAt`, `usedOcrFallback` are small additions beyond the decision list; they are needed for page links, the wizard, persona suggestions, starter generation after persona acceptance and restart safety.
- `Course.code` for new spaces: slug of the name + 6 random chars (`organic-chem-a1b2c3`); not shown as the primary label.
- `courseId` on sessions/plans stays nullable so legacy rows never block the migration; all new code sets it.
- Delete rules: deleting a `Course` removes its sources, topics, exercises, sessions, session items, logs and plans. Deleting a `Source` removes its topics and their exercises and logs, so `removeSourceAction` refuses when any of those topics has logs. Normal UI paths never delete exercises; they set `status = 'retired'`.
- The reviewer asked for indexes on `ExerciseLog(sessionId)` and `ExerciseLog(exerciseId)`; the unique `(sessionId, exerciseId)` index covers `sessionId`-leading lookups, so no separate `sessionId` index.
- `@@unique([sessionId, exerciseId])` on logs means one graded attempt per exercise per session (the first). `logAnswer` ignores a second attempt (T08).

### 3.2 Applying it to the existing 133 MB `dev.db` (task T02)

Run from `web/`. Stop any running `next dev`/`next start` first (SQLite file lock + consistent backup).

1. **Backup** (also done in T01; repeat right before migrating):
   `mkdir -p backups && sqlite3 dev.db ".backup 'backups/dev-pre-studyspaces-$(date +%Y%m%d-%H%M%S).db'"` and record row counts:
   `sqlite3 -readonly dev.db "select (select count(*) from Course),(select count(*) from Topic),(select count(*) from Exercise),(select count(*) from StudySession),(select count(*) from StudyPlan),(select count(*) from ExerciseLog);"` → expected `2|1322|1172|31|0|737`.
2. **Confirm no drift** with the OLD schema still in place:
   `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` must print an empty script (or only comments). If it prints DDL, stop and report; do not continue.
3. **Baseline** the migration history (adopt Prisma Migrate; the DB was created with `db push`):
   - `mkdir -p prisma/migrations/0_init`
   - `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`
   - create `prisma/migrations/migration_lock.toml` containing `provider = "sqlite"` (match what `prisma migrate dev` would write; check the format in `node_modules/prisma` docs/skill if unsure)
   - `npx prisma migrate resolve --applied 0_init`
4. **Edit** `prisma/schema.prisma` to section 3.1.
5. **Generate** the migration without applying:
   - `mkdir -p prisma/migrations/20261110000000_studyspaces`
   - `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > prisma/migrations/20261110000000_studyspaces/migration.sql`
   - **Prepend the duplicate-log cleanup** at the very top of `migration.sql` (the unique index would fail otherwise). Today there are 2 duplicate `(sessionId, exerciseId)` pairs: one pair of 2 rows written 0.2 s apart (double submit) and one triple of re-answers in one session; 3 surplus rows in total. Keep the earliest attempt:
     ```sql
     DELETE FROM "ExerciseLog" WHERE "id" IN (
       SELECT l."id" FROM "ExerciseLog" l
       WHERE EXISTS (
         SELECT 1 FROM "ExerciseLog" e
         WHERE e."sessionId" = l."sessionId" AND e."exerciseId" = l."exerciseId"
           AND (e."timestamp" < l."timestamp" OR (e."timestamp" = l."timestamp" AND e."id" < l."id"))
       )
     );
     ```
     Before applying, export the rows that will be deleted for the record: `sqlite3 -readonly dev.db "<the inner SELECT with all columns>" > backups/deleted-duplicate-logs.txt`.
   - Read the SQL. Expect `CREATE TABLE "Source"`, `CREATE TABLE "SessionExercise"`, new indexes, and SQLite "redefine table" blocks (`PRAGMA foreign_keys=OFF; CREATE TABLE "new_X" …; INSERT INTO "new_X" (…) SELECT … FROM "X"; DROP TABLE "X"; ALTER TABLE "new_X" RENAME TO "X"; PRAGMA foreign_keys=ON`) for `Course`, `Topic`, `Exercise`, `StudySession`, `StudyPlan`, `ExerciseLog`. Check that every `INSERT … SELECT` lists all old columns. There must be no `DROP TABLE` without a matching `INSERT … SELECT`.
6. **Apply**: `npx prisma migrate deploy`, then `npx prisma generate`.
7. **Verify**: count query → `2|1322|1172|31|0|734` (737 minus the 3 duplicates); `npx prisma migrate status` ("Database schema is up to date"); `sqlite3 -readonly dev.db "pragma integrity_check; pragma foreign_key_check;"` → `ok` and no rows; `sqlite3 -readonly dev.db "select * from pragma_foreign_key_list('ExerciseLog')"` shows `CASCADE` for both keys; `select count(*) from (select sessionId, exerciseId from ExerciseLog group by 1,2 having count(*)>1)` → 0.
8. **Rollback** if anything fails: stop, `cp backups/<file>.db dev.db`, delete `prisma/migrations/20261110000000_studyspaces`, report.

From now on schema changes go through `prisma migrate dev --create-only` + review + `prisma migrate deploy`; never `db push` against `dev.db` again.

### 3.3 Backfill (task T03, script `src/scripts/backfill-studyspaces.ts`, idempotent)

Run with `npx tsx src/scripts/backfill-studyspaces.ts [--dry-run]`. Uses the same Prisma client construction as `src/lib/db.ts`. Prints a report. Steps:

1. **Course titles/descriptions**: only where `title === code`: `14.750x` → "14.750x Political Economy and Economic Development"; `JPAL102x` → "JPAL102x Designing and Running Randomized Evaluations".
2. **Profiles**: if `profile IS NULL`, write `LEGACY_PROFILES[code]` (from `src/lib/studyspace/legacyProfiles.ts`, section 5.2). Legacy courses get `starterStatus = 'done'`.
3. **`Topic.order`** (per course, only if every topic of the course has `order = 0`): read `../MIT_Learn_Courses/<code>_outline.json`. Rank = `sectionIndex * 1000 + linkIndex` for the link whose `text === topic.className`. Sort topics by `(rank ?? Infinity, week, unitNumeric, unit, resourceType, title, id)` and assign `order = 10 * position`. If the outline file is missing, sort by `(week, unitNumeric, title, id)`.
4. **`Topic.isQuantitative`**: `true` where lowercased `week` contains any of `week_03`, `week 3`, `week_06`, `week 6`, `week_09`, `week 9` (today's `determineTargetQuestionType` predicate).
5. **`StudySession.courseId`** (only where null): (a) majority course of the session's logs; (b) else majority course of `exerciseIds`; (c) else a course whose `code` prefixes `title`; (d) else null. `mode = 'global_diagnosis'` rows stay null.
6. **`StudyPlan.courseId`**: majority course of its sessions; none exist today.
7. **`SessionExercise`** (only for sessions without items): one row per id in `exerciseIds` (skip ids whose exercise no longer exists), `position` = array index. `targetCount` = array length where null. `deadline` stays null for legacy sessions (no active legacy exam is resumed; see T17).
8. **`Exercise.origin`**: `generated` where `id LIKE 'gen-%'`, else `imported`.
9. **Enrichment marker → columns**: for exercises whose `questionText` starts with `<!-- enriched -->` (469 today): strip the marker and following newline, set `enrichedAt = now`. Try to recover `originalQuestionText` for imported ones: re-parse the topic's markdown file (`Topic.localPath`, `parseExerciseMarkdown` from `src/services/ingest.ts`) and match the parsed item with identical `correctAnswer` and `JSON.stringify(choices)`; on a unique match store its `questionText`. Report recovered / unmatched counts.
10. **`Exercise.isGraded` (reviewed)**: compute candidates with the conservative rule in `backfillRules.ts`: topic title matches `/required participation|ungraded|feedback|sign-?up/i` or is an entrance/exit/course survey (`/\b(entrance|exit|course) survey\b/i`), or question text matches `/how many hours did you spend|hours per week|time spent/i`, or a multi-select where every choice is marked correct (the "discussion/survey" case already treated as auto-correct in `StudyInterface`). The word "survey" alone is NOT a reason: today's filter also drops graded content topics such as "Survey I/II/III", "Survey Formatting", "Education Survey Example" and "Building the Survey Team" (checked 2026-11-10), and many graded questions mention survey design. `--dry-run` writes `backups/isGraded-review.tsv` (id, topic title, first 160 chars of question, rule matched) and prints the count; the implementer reads the file, fixes the rule if a real graded question is caught, and only then runs with `--apply-graded`, which sets `isGraded = false` for the listed ids. For comparison print how many exercises today's text filter in `createStudySession` excludes (132 on 2026-11-10).
11. Report: per-course counts for each step.

The pure parts (outline ranking, quantitative predicate, majority choice, marker stripping, graded rule) live in `src/lib/studyspace/backfillRules.ts` and are unit-tested.

### 3.4 Storage layout

`STORAGE_DIR` env, default `path.join(process.cwd(), 'storage')` (i.e. `web/storage/`, next to `dev.db`). Gitignored.

```
storage/
  sources/<courseId>/<sourceId>/original.<ext>   uploaded bytes
  sources/<courseId>/<sourceId>/pages.json       extracted pages: { pages: { n: number; text: string }[]; ocr: boolean }
  summaries/<courseId>/<moduleKey>.md            module summaries for NEW spaces
  summaries/sessions/<sessionId>_index.md        session index files for NEW sessions
```

Legacy summaries stay where they are (`summaries/<code>/…`, tracked in git). `summaryDirFor(course)` returns `summaries/<code>` if that directory exists, else `storage/summaries/<courseId>`. Session index files: write new ones to `storage/summaries/sessions/`; read legacy ones from `summaries/`.

### 3.5 Course/topic conventions for uploaded content

- `week` = `"NN · <Module title>"` (`NN` zero-padded module index, so string sort still works); `className` = `Source.originalName`; `unit` = topic index within module as string; `resourceType` = `"Uploaded PDF"` / `"Uploaded text"`; `localPath` = null; `content` = page text from `pageStart..pageEnd` (capped, see 4.4); `summary`, `keyTerms`, `isQuantitative`, `pageStart`, `pageEnd` from segmentation; `order` assigned after all sources of a bundle, appended after the course's current max order.
- Imported exercise ids: `imp-<uuid>`. Starter/generated exercise ids: `gen-<uuid>` (same as today).

### 3.6 Search (replacing the keyword list): no FTS5

FTS5 works in SQLite, but Prisma Migrate has no model for virtual tables; an FTS5 table and its shadow tables would show up as drift in `migrate diff`, and future generated migrations would try to drop them (assumption, not tested). The corpus is small (~6.5 M chars, 1,322 rows), so a plain scan is fast enough. Recommendation:

`searchTopics(courseId, queryText, opts)` in `src/services/contextSearch.ts`:
1. Build the space vocabulary: union of all `keyTerms` of the course's topics (cached in memory per course for 5 minutes; for legacy courses without keyTerms, fall back to title words). Extract candidate terms from `queryText`: vocabulary terms that occur in it (case-insensitive), plus capitalised tokens and tokens of length ≥ 6 not in a small stopword list; cap 12 terms.
2. Query `prisma.topic.findMany({ where: { courseId, OR: terms.flatMap(t => [{ title: { contains: t } }, { summary: { contains: t } }, { keyTerms: { contains: t } }, { content: { contains: t } }]), NOT: excludeWeeks }, select: { id, title, week, resourceType, content, summary, keyTerms }, take: 40 })`.
3. Score in JS: +5 per term in `keyTerms`, +3 in title, +2 in summary, +1 per occurrence in content (cap 10 per term). Return top `limit` (default 10) with content truncated to `maxCharsPerTopic` (default 50,000, same as today).

Legacy behavior note: the old list included author names (e.g. "duflo", "olken"); they match through the content scan because capitalised tokens from the question text are included as terms.

---

## 4. Ingestion pipeline

### 4.1 Limits

| Item | Limit | On violation |
|---|---|---|
| File types | `.txt`, `.md`, `.pdf` (by extension and sniffed: PDF must start with `%PDF-`) | reject at upload, 415 |
| File size | 50 MB per file, 20 files per request | reject at upload, 413 |
| Extracted text per source | 2,000,000 chars | `failed` at `extracting`, error "Document too long (N chars, limit 2,000,000)" |
| OCR fallback | PDF ≤ 20 MB and ≤ 300 pages | `failed` with "Scanned PDF too large for the Gemini fallback (limit 20 MB / 300 pages)" |
| Starter exercises | 2 per topic, max 60 per source | stop generating; `warning` |
| Topic content | 120,000 chars | split topic into "Title (part k)" |

### 4.2 Source status state machine

```
uploaded ──► extracting ──► segmenting ──► importing_questions ──► generating_exercises ──► ready
    │             │              │                  │                        │
    └─────────────┴──────────────┴──────────────────┴──► failed (failedStage = the stage, error = reason)
```
- `generating_exercises` runs only when the course already has an accepted `profile` (later uploads). For a new space (no profile yet) the source goes from `importing_questions` straight to `ready`, and the course gets `starterStatus = 'waiting_for_profile'`; starter exercises are generated by a course job after the persona is accepted (4.6).
- `ready` is reached even if some starter exercises failed (set `warning`).
- `retrySource(id)`: allowed only from `failed`; sets `status = failedStage`, clears `error`, enqueues.
- Each stage is idempotent: `segmenting` first deletes topics of this source that have no exercise logs (and their exercises); `importing_questions` deletes `imp-` exercises of this source's topics without logs; `generating_exercises` only tops topics up to 2 starter exercises.
- Persona step is a course-level step, not a source state (4.6).

### 4.3 Background runner (single local Node process)

`src/server/ingest/runner.ts`:
- Module-level singleton stored on `globalThis.__feynmanIngestRunner` (survives dev HMR). Holds an in-memory FIFO of jobs `{ kind: 'source', id } | { kind: 'starters', courseId }` and processes **one job at a time**.
- `enqueueSource(id)` / `enqueueStarters(courseId)` push and start the loop if idle; return immediately (fire-and-forget; errors are caught and written to the source or to `Course.starterStatus = 'failed'`).
- Claim: before working, `prisma.source.updateMany({ where: { id, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] }, data: { leaseExpiresAt: now + 10 min } })`; if `count === 0`, skip (another process — e.g. `next dev` and the launchd `next start` on the same DB — owns it). Renew the lease at each stage start. Clear it at `ready`/`failed`.
- Resume after restart: `src/instrumentation.ts` `register()` (Node runtime only) dynamically imports `@/server/ingest/runner` and calls `resumePendingSources()`, which enqueues all sources whose status is not `ready`/`failed` (oldest first) and all courses with `starterStatus` in (`pending`, `running`). Each resumes at its current status (stages are idempotent). Also called lazily by `getSpaceStatus` if the runner is idle and pending sources exist (safety net if `register` did not run).
- After each source reaches a terminal state, the runner calls `maybeProposeProfile(courseId)` (4.6).
- LLM calls inside a stage run with concurrency 3 (simple `p-limit`-style helper written inline, no new dependency).

The upload route handler saves files, creates `Source` rows, calls `enqueueSource` for each and returns. If `after` from `next/server` is preferred, wrap the enqueue in `after(() => …)`; both work because the runner does not block the response.

### 4.4 Extraction (`src/server/ingest/extract.ts`)

- `.txt` / `.md`: read UTF-8 (strip BOM). Split into synthetic pages of ≈4,000 chars, cutting at the last blank line (or Markdown heading for `.md`) before the limit. Page numbers are 1-based chunk indices. `pageCount` = chunks.
- `.pdf`: `pdf-parse` v2 `new PDFParse({ data }).getText()`; use its per-page result (expected `result.pages: { num, text }[]` — verify the shape in `node_modules/pdf-parse`, recorded in T01 and used in T21). Sparse test: `avgCharsPerPage < 200` or `> 40 %` of pages have < 50 chars → OCR fallback.
- OCR fallback: Gemini native PDF input via the AI SDK file part (`{ type: 'file', data: <Buffer>, mediaType: 'application/pdf' }` in a user message — verify the property names for `ai` v7 in `node_modules/ai` docs). Process page ranges of 15 pages per call: prompt "Transcribe pages a–b of the attached PDF. Return JSON {pages:[{n,text}]}. Keep math as LaTeX. Do not summarize." Schema `OcrPagesSchema`. Each call re-sends the PDF (accepted cost). Set `usedOcrFallback = true`.
- Write `pages.json`, set `pageCount`, `charCount`.

### 4.5 Segmentation (`src/server/ingest/segment.ts`) and long documents

- Text with markers: each page rendered as `[[p:N]]\n<text>`.
- If total chars ≤ 60,000: **single call** with `SegmentationOutputSchema` (modules → topics).
- Otherwise **windowed**: windows of ~60,000 chars on page boundaries, 1 page overlap. Each window call returns `WindowTopicsSchema` (flat topics with page ranges + `moduleHint`). The previous window's last topic title is passed in so a topic crossing the boundary is continued, not duplicated. Then **one merge call** (`ModuleGroupingSchema`) receives only `{ index, title, pageStart, pageEnd, summary, moduleHint }` for all window topics (small) and returns modules as ordered lists of topic indices, plus `mergeGroups` (indices to merge as one topic).
- An 830k-char document → ~14 window calls (concurrency 3) + 1 merge call. Input to the merge call stays well under 100k chars because it carries summaries, not content.
- Post-processing in code (`normalizeSegments`, pure, unit-tested): clamp page ranges to `[1, pageCount]`, sort, make ranges contiguous (gaps go to the previous topic; overlaps are cut at the next topic's start), drop empty topics, cap 40 modules / 400 topics per source (merge smallest adjacent topics beyond the cap), split topics over 120k chars into parts.
- Create `Topic` rows in one `$transaction`.

### 4.6 Question import, starter exercises, persona trigger

- **Question import** (`src/server/ingest/importQuestions.ts`): for `.md` files first try `parseExerciseMarkdown` (existing edX format); keep results with a correct answer. Otherwise, run a cheap heuristic per topic (`/\b(question|exercise|problem)\s*\d|\?\s*$|^\s*\(?[a-d]\)\s/im` counts ≥ 3) and, for matching topics only, call the LLM with `ImportedQuestionsSchema`. Keep only questions whose correct answer is stated in the source text; never invent answers. Save as `imp-` exercises with the same JSON conventions as today (`choices` JSON string; multiple_choice `correctAnswer` as JSON array string).
- **Imported-question enrichment** (uploaded content only, inside `importing_questions`): for each imported question that refers to material outside itself (same heuristic as the session-start enrichment), run the enrichment prompt with the topic's own content capped at 20,000 chars; apply the same leak check (5.4); set `originalQuestionText` and `enrichedAt`. Session start never enriches exercises of topics with a `sourceId`.
- **Starter exercises**, two paths:
  - Course job `generateStarters(courseId)` for a NEW space: triggered by `acceptProfileAction` when `starterStatus === 'waiting_for_profile'` (sets `pending`, enqueues). It generates up to 2 exercises per topic with the accepted profile, max 60 per source, sets `running` then `done` (or `failed` with the error in a log line; the UI shows "Starter questions could not be generated; sessions will generate questions on the fly").
  - Stage `generating_exercises` for a source with `bundle = 'later'` in a space that already has an accepted profile: same generator, same caps.
  - Both use `generateExerciseForTopic` (5.4, including validation); failures are counted into `warning`.
- **Persona trigger** `maybeProposeProfile(courseId)`: if `course.profile` is null and `profileSuggestion` is null and every `bundle = 'initial'` source is `ready` or `failed` and at least one is `ready` → `proposeProfile(courseId)` → store `ProfileSuggestion { kind: 'initial', … }`. If `course.profile` is set and the finished source has `bundle = 'later'` → `suggestProfileUpdate(courseId, sourceId)` → `ProfileSuggestion { kind: 'update', … }` (only if the LLM says a change is warranted). If all initial sources failed → no proposal; UI shows the failures and offers retry/remove.

Starter exercises for a new space are never generated with `defaultProfile`; they wait for the accepted persona. Until then (and if the owner never accepts one), study sessions generate questions on the fly with `defaultProfile`.

---

## 5. Module layout

### 5.1 New files

| Path | Responsibility |
|---|---|
| `src/server/auth.ts` | `requireAuth(): Promise<void>` (T04) |
| `src/lib/grading.ts` | pure `gradeAnswer()` used by client and server (T12) |
| `src/lib/exerciseValidation.ts` | pure structural checks for generated/imported exercises (T14) |
| `src/services/sessionService.ts` | server-owned session state: start, state, drafts, flags, position, submit, cancel, active session lookup (T12, T17) |
| `src/services/voiceContext.ts` | capped per-exercise context for the voice tutor (T07) |
| `src/services/liveToken.ts` | Gemini Live ephemeral token minting (T05) |
| `src/lib/ai.ts` | `export const TEXT_MODEL_ID = 'gemini-3.6-flash'`; `export function textModel() { return google(TEXT_MODEL_ID) }`. All `google('gemini-3.6-flash')` calls switch to this. |
| `src/lib/studyspace/profile.ts` | zod `TutorProfileSchema`, `ProfileSuggestionSchema`, `PRESETS`, `parseProfile`, `defaultProfile`, `applyPreset`. Pure, client-safe. |
| `src/lib/studyspace/legacyProfiles.ts` | `LEGACY_PROFILES: Record<'14.750x' \| 'JPAL102x', TutorProfile>` |
| `src/lib/studyspace/backfillRules.ts` | pure backfill helpers |
| `src/lib/prompts/index.ts` (+ one file per prompt group) | every prompt builder; pure string functions taking `TutorProfile` + data; client-safe (no server imports) |
| `src/lib/fileLinks.ts` | build/parse file links (client-safe) |
| `src/services/studyspaceService.ts` | `getCourseWithProfile`, `getProfileForCourse`, `getProfileForTopic`, `listStudyspaces`, `createStudyspace`, `renameStudyspace`, `deleteStudyspace`, outline edits |
| `src/services/contextSearch.ts` | `searchTopics`, `getPrecedingTopicsContext` |
| `src/services/exerciseGenerator.ts` | shared single-exercise generation (extracted from `generateNextExercise`) |
| `src/server/storage.ts` | `STORAGE_DIR`, `sourceDir`, `writeSourceFile`, `readSourceFile`, `readPages`, `writePages`, `summaryDirFor`, safe path join |
| `src/server/ingest/{extract,segment,importQuestions,runner,profileProposal,schemas}.ts` | pipeline |
| `src/server/phoneAccess.ts` | Tailscale CLI wrapper |
| `src/server/requestOrigin.ts` | `isLocalRequest(headers)` |
| `src/instrumentation.ts` | resume ingestion on boot |
| `src/app/spaces/page.tsx` | studyspace list + Phone access card |
| `src/app/spaces/new/page.tsx` | wizard step 1 (name + goal) |
| `src/app/spaces/[id]/page.tsx` | study interface for one space |
| `src/app/spaces/[id]/setup/page.tsx` | wizard steps 2–5 (upload, processing, outline, persona) |
| `src/app/spaces/actions.ts` | `'use server'` actions for spaces/outline/persona |
| `src/app/api/spaces/[id]/sources/route.ts` | POST multipart upload |
| `src/app/api/files/topic/[topicId]/route.ts`, `.../source/[sourceId]/route.ts`, `.../summary/route.ts` | file serving by id/key |
| `src/app/api/phone-access/route.ts` | GET status, POST enable/disable |
| `src/app/manifest.ts` | web app manifest |
| `src/components/features/spaces/*` | `SpaceCard`, `NewSpaceForm`, `SourceDropzone`, `ProcessingView`, `OutlineEditor`, `PersonaCard`, `ProfileSuggestionBanner`, `PhoneAccessCard` |
| `scripts/launchd/com.feynman.studyhub.plist.template`, `scripts/launchd/install.sh`, `scripts/launchd/uninstall.sh` | owner-run service install |

### 5.2 Profile schemas (`src/lib/studyspace/profile.ts`)

```ts
import { z } from 'zod'

export const QuestionTypeMixSchema = z.object({
  single_choice: z.number().min(0).max(1),
  multiple_choice: z.number().min(0).max(1),
  numeric: z.number().min(0).max(1),
  dropdown: z.number().min(0).max(1),
})

export const TutorProfileSchema = z.object({
  version: z.literal(1),
  subject: z.string().min(1).max(120),            // "Development economics: political economy"
  level: z.enum(['intro', 'undergraduate', 'graduate', 'professional']),
  tutorIdentity: z.string().min(1).max(200),      // one line: "an MIT economics professor who teaches political economy"
  tone: z.enum(['socratic_professor', 'patient_coach', 'exam_driller']),
  toneNotes: z.string().max(300).default(''),
  analogyDomains: z.array(z.string().max(40)).max(5),
  quantitative: z.boolean(),
  questionTypeMix: QuestionTypeMixSchema,         // used for non-quantitative topics
  quantitativeQuestionTypeMix: QuestionTypeMixSchema, // used for isQuantitative topics
  contentLanguage: z.string().min(2).max(10),     // BCP-47, e.g. "en", "pt-BR"
  sampleExplanation: z.object({ concept: z.string(), explanation: z.string().max(1200) }),
  calibrationModule: z.string().nullable(),       // Topic.week value used for rigor examples; null = none
  examPreset: z.object({ label: z.string(), questionCount: z.number().int().min(1).max(200) }).nullable(),
  questionTypeCycles: z.object({ quantitative: z.array(TypeEnum), qualitative: z.array(TypeEnum) }).nullable(), // legacy override, see below
})
// TypeEnum = z.enum(['single_choice', 'multiple_choice', 'numeric', 'dropdown'])
export type TutorProfile = z.infer<typeof TutorProfileSchema>

// What the LLM returns for a proposal (code adds the rest)
export const ProfileProposalSchema = z.object({
  profile: TutorProfileSchema.omit({ version: true, calibrationModule: true, examPreset: true, questionTypeCycles: true }),
  subjectsCoherent: z.boolean(),
  subjectGroups: z.array(z.object({ label: z.string(), sourceIds: z.array(z.string()) })), // only meaningful when !subjectsCoherent
})

export const ProfileSuggestionSchema = z.object({
  kind: z.enum(['initial', 'update']),
  createdAt: z.string(),
  profile: TutorProfileSchema,
  rationale: z.string().max(600),
  excludedSources: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })),
  split: z.object({ groups: z.array(z.object({ label: z.string(), sourceIds: z.array(z.string()) })) }).nullable(),
})
export type ProfileSuggestion = z.infer<typeof ProfileSuggestionSchema>

export const PRESETS: Record<TutorProfile['tone'], { label: string; toneNotes: string }>
// socratic_professor: "Ask before telling; probe reasoning; rigorous."
// patient_coach: "Short steps, frequent encouragement, more hints before questions."
// exam_driller: "Exam-style questions, time awareness, concise corrections."

export function parseProfile(json: string | null | undefined): TutorProfile | null // safeParse; null on failure
export function defaultProfile(course: { title: string; goal?: string | null }): TutorProfile // neutral, level 'undergraduate', tone 'socratic_professor', mixes below
export function applyPreset(p: TutorProfile, tone: TutorProfile['tone']): TutorProfile
export function pickQuestionType(p: TutorProfile, isQuantitative: boolean, existingCount: number): 'single_choice' | 'multiple_choice' | 'numeric' | 'dropdown'
```

`pickQuestionType` returns `cycle[existingCount % cycle.length]`, where `cycle` is built deterministically from the mix: 10 slots allocated by largest-remainder rounding, then interleaved in the fixed type order `single_choice, numeric, multiple_choice, dropdown` (round-robin over types with remaining slots). Today's cycles cannot be expressed exactly as a mix (quantitative `['numeric','multiple_choice','single_choice','numeric','multiple_choice','dropdown']`, qualitative `['single_choice','dropdown','single_choice','multiple_choice','dropdown']`), so the schema also has an optional field `questionTypeCycles: z.object({ quantitative: z.array(TypeEnum), qualitative: z.array(TypeEnum) }).nullable()`; when set it overrides the mix. Legacy profiles set it to today's cycles, so legacy behavior is unchanged. Proposed profiles leave it null.

Gemini structured output note: keep schemas free of `z.record`, unions and recursive types for anything passed to `generateObject`. `.default('')` must not be used in schemas passed to `generateObject` (use the `omit`/`extend` variant without defaults and apply defaults in code).

`LEGACY_PROFILES` content (written by hand from today's prompt text):
- 14.750x: subject "Political economy and economic development", level graduate, identity "an MIT economics professor teaching the 14.750x MicroMasters course", tone socratic_professor, analogyDomains ["everyday markets", "water flows", "balance scales"], quantitative true, contentLanguage "en", calibrationModule "Week_13_Comprehensive_Review", examPreset {label: "14.750x Final", questionCount: 32}.
- JPAL102x: subject "Designing and running randomized evaluations", identity "an MIT/J-PAL professor teaching JPAL102x", same tone/domains, calibrationModule "Week_16_Comprehensive_Review", examPreset {label: "JPAL102x Final", questionCount: 53}.
- Verify the exact `week` strings against the DB before committing (`select distinct week from Topic where week like '%Comprehensive%'`).

### 5.3 Prompts module (`src/lib/prompts/`)

Rules for every builder:
- Signature `(profile: TutorProfile, input: {...}) => string`. No I/O. The fixed Feynman block (`FEYNMAN_METHOD`) is a constant appended or prepended by the builder; the persona only fills identity, level, tone notes, analogy domains, language.
- `persona(profile)` → `"You are ${tutorIdentity}. Teach at ${level} level. Tone: ${PRESETS[tone].label}. ${toneNotes} Prefer analogies from: ${analogyDomains}. Respond in ${contentLanguage}."`
- Link instructions come from `fileLinkInstructions()` and use topic ids (5.5), never paths.

| Builder | Replaces | Inputs |
|---|---|---|
| `explainMistakePrompt` | `actions.ts` ~27 | question, choices, answers, explanation, topicTitle |
| `enrichExercisePrompt` | ~223 | context text, exercise |
| `generateExercisePrompt` | ~944–1010 | topic {title, week, isQuantitative}, courseCode, bucketContext, rigorExamples (optional; omit the whole calibration section when empty), styleExamples, alreadyAsked, targetType. The generic parts (dedup, variation, grounding, self-containedness, format rules per type) stay as they are with "MIT"/"economics" wording replaced by the profile. The economics-specific blocks (named papers, econometric/microeconomic/survey synthesis methodology, empirical data tables) move verbatim to `src/lib/prompts/legacySubjectGuidance.ts` and are included only when `courseCode` is `14.750x` or `JPAL102x`. For other spaces, include a generic block: when the topic `isQuantitative`, require worked numbers, equations in LaTeX and optional Markdown tables; otherwise prefer scenario-based questions. |
| `examDiagnosisPrompt` | ~1230 | score, topic lines (with topic ids), wrong answers |
| `globalDiagnosisPrompt` | ~1373 | course title, topic lines, weak topic content |
| `plannerChatPrompt` | ~1462 | history, stats |
| `studyPlanPrompt` | ~1520 | history, stats, topic catalog (scoped to course), calibrationModule (optional: "final days target <module>" only when set) |
| `moduleSummaryPrompt` | `summaryService.ts` ~96 and `artifactsService.ts` ~141 (identical; dedupe) | course title, module, material |
| `voiceSystemInstruction` | `StudyInterface.tsx` ~173 | profile |
| `voiceExerciseContextMessage`, `voicePlannerContextMessage`, `voiceDashboardContextMessage` | ~914–948 | as today, links via topic ids; the hard-coded "2 hours morning/afternoon/night" sentence is removed |
| `segmentWindowPrompt`, `segmentSinglePrompt`, `moduleGroupingPrompt` | new | see below |
| `importQuestionsPrompt`, `ocrPagesPrompt` | new | |
| `proposeProfilePrompt`, `suggestProfileUpdatePrompt` | new | |

New prompt outlines:
- **segmentSinglePrompt / segmentWindowPrompt**: role "curriculum designer". Input: file name, page-marked text, (window) previous topic title + window range. Task: split into topics a student would study in one sitting (target 1–8 pages or 2k–15k chars each), group into modules (single) or give `moduleHint` (window). For each topic: title (≤ 80 chars, in the document's language), `pageStart`, `pageEnd` (from `[[p:N]]` markers only), 2–3 sentence summary, 3–8 key terms that literally appear in the text, `isQuantitative` (true if the topic requires calculations, formulas, proofs or reading numeric tables). Rules: cover every page, no overlaps, skip nothing; front matter/index pages go into a topic titled "Front matter" which code later drops if < 2 pages and no key terms.
- **moduleGroupingPrompt**: input list of topics; output modules (title ≤ 60 chars, ordered, contiguous topic indices) and `mergeGroups` for duplicates created by window boundaries.
- **importQuestionsPrompt**: input topic text; extract only questions present in the text whose answer is stated in the text; map to the four exercise types with the exact formatting rules used by `generateExercisePrompt`; include the source explanation when present; return `[]` if none.
- **ocrPagesPrompt**: as 4.4.
- **proposeProfilePrompt**: input: space name and goal, per source `{id, name, outline (module → topic titles + summaries), samples (≤ 3 × 1,500 chars)}`, total capped at 40,000 chars. Task: infer subject, level, a one-line tutor identity that a real expert in this subject would have, tone (default socratic_professor unless the goal suggests exam prep → exam_driller), 2–5 analogy domains suited to the subject, quantitative flag and both question-type mixes (each sums to 1; numeric weight 0 if not quantitative), content language of the materials, and a ≤ 150-word Feynman-style explanation of one concept that appears in the samples. Also decide `subjectsCoherent`; when false return `subjectGroups` (source ids by subject). Must not change the fixed method: "You only choose expertise, level, tone and language".
- **suggestProfileUpdatePrompt**: input current profile + new source outline + samples. Output `{ shouldUpdate: boolean, profile, rationale }`; `shouldUpdate` only if subject/level/language/quantitative materially change.

### 5.4 Shared exercise generator (`src/services/exerciseGenerator.ts`)

Extracted from `generateNextExercise` (actions.ts ~796–1041) without behavior change for legacy courses:

```ts
export async function generateExerciseForTopic(args: {
  primaryTopicId: string
  poolTopicIds: string[]          // topics allowed for the grounding bucket
  existingExerciseIds: string[]   // for dedup + type cycling
}): Promise<Exercise & { topic: Topic } | null>   // creates the Exercise row; does NOT touch sessions
```
Internals moved here: `fetchRigorExamples(courseId, profile)` (uses `profile.calibrationModule`; returns '' when null), `fetchLocalStyleExamples`, `compileGroundingContext` (the "comprehensive review" branch becomes "if topic.week === profile.calibrationModule then add `searchTopics` context"), `shuffleArray`, type choice via `pickQuestionType(profile, topic.isQuantitative, existingExerciseIds.length)`.
`generateNextExercise` in actions.ts keeps its signature and becomes: pick primary topic (same logic), call `generateExerciseForTopic`, append the exercise to the session (via `exerciseIds` until T17, via a `SessionExercise` row inserted in a transaction with `position = max + 1` from T17 on).

Changes layered on top in later tasks:
- **Smaller grounding (T13)**: the bucket context becomes the target topic's content capped at 24,000 chars plus, for up to 8 same-module sibling topics in the pool, `title + summary` (legacy topics without `summary`: title + first 600 chars). Calibration context (`searchTopics`) is capped at 15,000 chars total. Style examples stay (max 5).
- **Validation (T14)**: after `generateObject`, run `validateExerciseStructure()` (single_choice: 3–6 unique non-empty choices and `correctAnswer` exactly one of them; multiple_choice: `correctAnswer` is a JSON array, non-empty, subset of ≥ 3 unique choices, not all choices; numeric: `choices` empty, `correctAnswer` parses to a finite number; dropdown: exactly one `[Dropdown 1]` placeholder, 3–5 choices, `correctAnswer` one of them). Then a **blind solve**: a second `generateObject` call gets only the question and choices (no answer, no explanation) and the topic content, returns `{ answer: string }`; grade it with `gradeAnswer()`; if `score < 1`, the exercise is stored with `status = 'rejected'` and the generator retries (max 2 retries per slot). Accepted exercises get `origin`, `status = 'active'`, `promptVersion = GENERATE_EXERCISE_PROMPT_VERSION` (constant exported from the prompts module, bump it whenever the prompt text changes). Selection queries (`createStudySession`, style examples, rigor examples) use only `status = 'active'` exercises.
- **Leak check for enrichment (T15)**: reject an enriched text if a normalized correct answer (each correct option for single/multiple choice and dropdown, the number for numeric; only answers of ≥ 4 characters or numbers) appears in the enriched text but not in the original text.

### 5.5 File links (`src/lib/fileLinks.ts`)

New canonical forms (produced by prompts and UI):
- Topic material: `/api/files/topic/<topicId>` + optional `#page=N` (PDF) or `?highlight=<urlencoded quote>` (text).
- Source file: `/api/files/source/<sourceId>` (+ same suffixes).
- Summary: `/api/files/summary?course=<courseId>&key=<key>` where `key` matches `^[A-Za-z0-9._-]{1,120}$` and refers to a file in `summaryDirFor(course)`, or `?session=<sessionId>` for a session index file.
- Legacy `/api/file?path=…` keeps working (restricted, see T10).

```ts
export type FileLink = { url: string; page: number | null; highlight: string | null; kind: 'topic' | 'source' | 'summary' | 'legacy' }
export function topicFileLink(topicId: string, opts?: { page?: number; highlight?: string }): string
export function sourceFileLink(sourceId: string, opts?: { page?: number; highlight?: string }): string
export function summaryLink(courseId: string, key: string): string
export function sessionSummaryLink(sessionId: string): string
export function parseFileLink(href: string, origin?: string): FileLink | null // accepts all four forms; returns url without hash/highlight
```
The visualizer decides PDF vs text from the response `Content-Type` (fetch the url; if `application/pdf`, render the iframe with `url + '#page=N'`; else render text). Title: from a `X-File-Title` response header set by the routes (URL-encoded) or the link text.

### 5.6 Server actions for spaces (`src/app/spaces/actions.ts`)

All call `requireAuth()` (small helper in the same file wrapping `checkIsAuthenticated`).

```ts
export async function listStudyspacesAction(): Promise<SpaceSummary[]>            // id, title, code, goal, createdAt, topicCount, exerciseCount, lastSessionAt, sourceCounts by status, hasProfile, hasSuggestion
export async function createStudyspaceAction(input: { name: string; goal?: string }): Promise<{ id: string }>
export async function renameStudyspaceAction(id: string, name: string): Promise<void>
export async function deleteStudyspaceAction(id: string): Promise<void>           // refuses for courses that have ExerciseLogs unless confirmTitle === title; deletes storage dir
export async function getSpaceStatusAction(id: string): Promise<SpaceStatus>     // sources (status, error, warning, counts), profileSuggestion, profile
export async function retrySourceAction(sourceId: string): Promise<void>
export async function removeSourceAction(sourceId: string): Promise<void>        // only if its topics have no logs
export async function getOutlineAction(id: string): Promise<OutlineModule[]>      // modules (week) → topics (id, title, order, pageStart, pageEnd, sourceName, exerciseCount)
export async function renameTopicAction(topicId: string, title: string): Promise<void>
export async function renameModuleAction(courseId: string, from: string, to: string): Promise<void> // keeps the "NN · " prefix
export async function mergeTopicsAction(topicIds: string[]): Promise<{ id: string }> // same source, adjacent order; concatenates content, unions keyTerms, moves exercises, page range = min..max
export async function reorderAction(courseId: string, orderedTopicIds: string[]): Promise<void>    // rewrites order = 10*i and the NN prefix of week by first appearance
export async function moveTopicToModuleAction(topicId: string, module: string): Promise<void>
export async function regenerateProfileAction(courseId: string): Promise<ProfileSuggestion>
export async function acceptProfileAction(courseId: string, profile: TutorProfile): Promise<void> // validates, writes profile, clears suggestion
export async function dismissProfileSuggestionAction(courseId: string): Promise<void>
export async function splitStudyspaceAction(courseId: string, groups: { label: string; sourceIds: string[] }[]): Promise<{ ids: string[] }> // first group stays; others become new courses; moves sources + topics (+ their exercises); only allowed before any session exists in the course
export async function getProfileAction(courseId: string): Promise<TutorProfile>  // profile ?? defaultProfile
```

---

### 5.7 Tutor chat modes (owner decision, 2026-11-10)

How the tutor responds in the chat/voice panel is defined by the persona, and the student can switch mode in the chat. There is no global "always help when asked" rule.

- Modes (`TutorChatMode`, in `src/lib/studyspace/profile.ts`): `probe` (ask before telling: challenge the student's reasoning, give a hint only after an attempt), `guide` (short hints and steps toward the answer, one at a time, then a check question), `explain` (answer the question directly and briefly in Feynman style, then one check question).
- Default per persona: `TutorProfile` gains `defaultChatMode: TutorChatMode`. Presets: `socratic_professor` → `probe`, `patient_coach` → `guide`, `exam_driller` → `probe`. The persona card (T25) shows and lets the owner edit it. Legacy profiles use `probe` (today's behavior). `parseProfile` must accept stored profiles without the field and fill it from the tone preset.
- Exam sessions: the selector is hidden and the mode is fixed to an exam directive (no hints, no answers, no solution content), whatever the persona says.
- Prompts (`src/lib/prompts/`): `chatModeDirective(profile, mode, sessionMode)` returns the behavior block. The per-exercise context message ends with this directive instead of the hard-coded "act as the Thesis Examiner / initiate oral defense" paragraph; that paragraph's wording becomes the `probe` directive. `voiceSystemInstruction(profile)` no longer hard-codes examiner behavior.
- Switching: the tutor panel has a three-way selector. Changing it sends `sendContext("[SYSTEM MESSAGE: The student switched the tutor to <mode> mode. <directive>]", { interrupt: false })`; no reconnect. The chosen mode is kept per studyspace in localStorage (`feynman_chat_mode_<courseId>`) and falls back to `profile.defaultChatMode`.
- The mode is part of the context key only for the switch message; it must not cause the exercise context to be re-sent.

---

## 6. Tasks (strict linear order)

Every task's **Verify** block includes: `npm run lint`, `npm run typecheck`, `npx vitest run` (no new failures vs. the T01 baseline; new tests pass), `npm run build` where stated, and a short manual browser check. Manual checks use `npm run dev` on `http://localhost:3000` unless stated otherwise; log in with the passcode from `.env`. For `curl` checks use `-b "feynman_session=$APP_PASSCODE"` with the value from `.env`.

"MIT regression check" (referenced below): open each of the two MIT courses (route depends on the phase: `/study` before T19, `/spaces/<id>` after), start a 5-question Study session with 50 % AI mix, answer one question, confirm a background-generated question arrives, open a slide PDF and a transcript from Resources, open the Analytics tab.

"Exam check": start a 5-question timed Exam, answer 3, flag 1, submit, confirm the diagnosis opens in the visualizer and its links open.

---

### Phase A — Foundation

#### T01 — Environment setup and baseline (haiku)
Files: `package.json`, `package-lock.json`, `.gitignore` (web), `STUDYSPACES_PLAN.md` (append to section 10 only).
Steps:
1. `cd web && git status && git branch --show-current` → must be `feature/studyspaces`; stop if not.
2. Back up the DB: `mkdir -p backups && sqlite3 dev.db ".backup 'backups/dev-T01-$(date +%Y%m%d-%H%M%S).db'"`; verify the backup opens: `sqlite3 -readonly backups/<file> "select count(*) from Topic"` → 1322.
3. `npm ci`. Then `npm install zod@<the version currently resolved under node_modules/zod>` so it is declared (check `node_modules/zod/package.json` first; keep the same major version that `ai` uses).
4. Add script `"typecheck": "tsc --noEmit"` to `package.json`.
5. Add to `web/.gitignore`: `/storage/`, `/backups/`.
6. `npx prisma generate`.
7. Read in `node_modules/next/dist/docs/`: route handlers (`route.md`/`route.mdx`), `after`, `instrumentation`, `serverActions` config (`allowedOrigins`, `bodySizeLimit`), dynamic `params`, `manifest`, `next start` CLI. Read `node_modules/pdf-parse` README/types for the per-page result of `getText()` and `node_modules/ai` docs for file parts (`type: 'file'`, `mediaType`). Append findings to section 10 "Confirmations" (one line each: confirmed / differs: …).
8. Record the baseline: output summary of `npm run lint`, `npm run typecheck`, `npx vitest run` into section 10 "Baseline" (counts of errors/failures, names of failing tests).
Verify: `npm run build` succeeds (or record the pre-existing failure in Baseline and stop to report). `npm run dev`, log in, MIT regression check via `/study`.
Commit: `chore(web): install dependencies, declare zod, add typecheck script, record baseline`

#### T02 — Schema, indexes, delete rules and migration adoption (sonnet)
Depends: T01. Files: `prisma/schema.prisma`, `prisma/migrations/migration_lock.toml`, `prisma/migrations/0_init/migration.sql`, `prisma/migrations/20261110000000_studyspaces/migration.sql`.
Steps: exactly section 3.2 with the schema of 3.1 (includes the duplicate-log cleanup). Do not change application code, with one exception: if `npm run typecheck` fails because generated types changed (for example `logs` include shapes), make the minimal type-only fix. All new columns are nullable or defaulted, so existing code keeps working.
Verify: section 3.2 step 7; `npm run typecheck`, `npx vitest run`, `npm run build`; MIT regression check via `/study`; Exam check.
Commit: `feat(db): adopt prisma migrate baseline; add studyspace schema, session items, indexes and cascades`

#### T03 — Profile types, legacy profiles, backfill (sonnet)
Depends: T02. Files (new): `src/lib/studyspace/profile.ts`, `src/lib/studyspace/profile.test.ts`, `src/lib/studyspace/legacyProfiles.ts`, `src/lib/studyspace/backfillRules.ts`, `src/lib/studyspace/backfillRules.test.ts`, `src/scripts/backfill-studyspaces.ts`.
Steps: implement 5.2 and 3.3. Because the marker is stripped from the 469 enriched rows, change the enrichment check in `createStudySession` to also skip exercises with `enrichedAt` set (small change; the full rework is T15), otherwise session start would re-enrich them. Run `--dry-run`, read the report and `backups/isGraded-review.tsv`, back up (`sqlite3 dev.db ".backup 'backups/dev-T03-pre.db'"`), run without `--dry-run`, then with `--apply-graded` after the review, then once more to prove idempotence (0 changes).
Tests: `parseProfile` rejects garbage and accepts both legacy profiles; `pickQuestionType` reproduces both legacy cycles for `existingCount` 0..11; outline ranking + fallback; quantitative predicate matches `Week_06_Sampling_and_Sample_Size` and `Week_09_Week_8__Corruption_I`, not `Week_10_…`; majority helper; marker stripping; graded rule: "How many hours did you spend…" → ungraded, "Which survey design reduces recall bias?" → graded.
Verify: `sqlite3 -readonly dev.db "select code, profile is not null, starterStatus from Course; select count(*) from Topic where \"order\" > 0; select count(*) from StudySession where courseId is null; select count(*) from SessionExercise; select count(*) from Exercise where questionText like '<!-- enriched -->%'; select count(*) from Exercise where isGraded = 0; select origin, count(*) from Exercise group by 1;"` → profiles set, `done`; ordered topics reported; ≤ 4 null sessions; SessionExercise > 0; 0 markers left; the reviewed ungraded count; `generated|34`. Lint/typecheck/vitest. MIT regression check via `/study`; starting a session does not re-enrich already enriched questions (`select count(*) from Exercise where enrichedAt > datetime('now','-5 minutes')` stays 0 apart from new ones).
Commit: `feat(studyspace): TutorProfile schema, legacy profiles and idempotent data backfill`

### Phase B — Fix first (existing UI, existing routes)

#### T04 — Auth on every server action; production bound to localhost (haiku)
Depends: T03. Files: new `src/server/auth.ts`, `src/app/actions.auth.test.ts`; modify `src/app/actions.ts` (first line of every exported function), `src/app/auth-actions.ts` (`getGeminiApiKey` uses `requireAuth`), `package.json` (`"start": "next start -H 127.0.0.1"`).
Steps:
1. `src/server/auth.ts`: `export async function requireAuth(): Promise<void> { if (!(await checkIsAuthenticated())) throw new Error('Unauthorized') }`. Not a `'use server'` file (plain server module), so it can export a helper.
2. Add `await requireAuth()` as the first statement of every exported async function in `src/app/actions.ts`. Do this explicitly per function, not with a higher-order wrapper: a `'use server'` file may only export async functions, and whether `export const x = wrap(async () => …)` passes the Next 16 server-actions compiler check is not confirmed (U14). Where a function catches all errors and returns a fallback (`try { … } catch { return null }`), put `requireAuth()` before the `try` so `Unauthorized` is not swallowed.
3. Test: mock `@/app/auth-actions` (`checkIsAuthenticated` → `false`), `@/lib/db`, `ai`, `@ai-sdk/google`; `import * as actions from './actions'`; for each exported function, `await expect(fn()).rejects.toThrow('Unauthorized')` and assert no prisma method was called. Also assert the export count is > 30, so a broken import cannot pass vacuously.
4. Existing tests in `actions.test.ts`: mock `@/server/auth` to resolve.
Verify: lint/typecheck/vitest/`npm run build`; `npm run start` then `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/` → 200 and `lsof -iTCP:3000 -sTCP:LISTEN` shows `127.0.0.1:3000` only (not `*:3000`); stop it. Browser (dev): logged out in a private window, the study page redirects to login; logged in, MIT regression check via `/study`.
Commit: `fix(security): require authentication in every server action and bind production to localhost`

#### T05 — Gemini Live ephemeral tokens instead of the API key in the browser (sonnet)
Depends: T04. Files: new `src/services/liveToken.ts` (+ test); modify `src/app/auth-actions.ts` (replace `getGeminiApiKey` with `createLiveToken`), `src/hooks/useLiveAPI.ts`.
Steps:
1. Read the current Live API reference (`https://ai.google.dev/api/live` and the ephemeral-token guide, now at `https://aistudio.google.com/docs/live-api/ephemeral-tokens`). Confirmed on 2026-11-10: tokens are created server-side with `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` (header `x-goog-api-key`), fields `uses`, `expireTime` (default 30 min), `newSessionExpireTime` (default 1 min), optional `liveConnectConstraints`; tokens work only with `v1beta`; without the SDK the client passes the token as the `access_token` query parameter or an `Authorization: Token <token>` header. NOT confirmed: the raw WebSocket path for token auth (expected `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<token.name>`) and whether `models/gemini-3.1-flash-live-preview` accepts token sessions (U15). Confirm both from the API reference before coding.
2. `createLiveToken()` (server action in `auth-actions.ts`, `requireAuth` first): `fetch` the endpoint with `{ uses: 1, expireTime: now + 30 min, newSessionExpireTime: now + 1 min }` (no `liveConnectConstraints`, so the client's setup message with the system instruction and history stays allowed); return `{ token: name, expiresAt }`. No new npm dependency.
3. `useLiveAPI.connect`: get a token instead of the key and open the token WebSocket URL. Remove `getGeminiApiKey`.
4. If step 1 shows tokens are not supported for this model or over raw WebSocket: do not change the connection; instead add a section-8 note "Live API key still reaches the browser: <reason, doc link>" and commit only the doc note. This task then has no code change.
Tests: `createLiveToken` posts the expected body and header (mock `fetch`), throws `Unauthorized` when unauthenticated, never returns the API key.
Verify: lint/typecheck/vitest/`npm run build`. Browser: start the voice tutor, talk for a minute, ask a question by voice; devtools Network → WS: URL contains `access_token=`, no `key=`; `grep -rn "getGeminiApiKey" src` → nothing. MIT regression check (quick).
Commit: `fix(security): connect the voice tutor with short-lived Gemini Live tokens`

#### T06 — Trim server payloads (sonnet)
Depends: T05. Files: `src/app/actions.ts`, `src/components/features/StudyInterface.tsx`, `src/components/features/SessionResultsDialog.tsx`, `src/components/features/SessionHistoryList.tsx`, `src/app/actions.test.ts`.
Steps:
1. Define select constants in `actions.ts`: `SESSION_LIST_SELECT` (id, title, startTime, endTime, status, mode, timeLimit, sourcingMix, studyPlanId, courseId, and `logs: { select: { id, exerciseId, isCorrect, userAnswer, timestamp, exercise: { select: { id, questionText, correctAnswer, exerciseType } } } }`; check with grep which log/exercise fields `SessionHistoryList`, `SessionResultsDialog` and the plan view in `StudyInterface` (~1515) read, and include exactly those), `EXERCISE_CLIENT_SELECT` (all exercise fields plus `topic: { select: { id, courseId, title, week, className, unit, resourceType, localPath, isQuantitative, course: { select: { id, code, title } } } }` — no `content`).
2. `getSessionHistory` and `getStudyPlans` (sessions) use `SESSION_LIST_SELECT`; no `chatLog`, `diagnosis`, `exerciseIds`, `draftAnswers`.
3. New action `getSessionDetail(sessionId)` → `{ chatLog, diagnosis }`. `SessionResultsDialog` loads it when opened (spinner while loading). The `StudyInterface` code that restores a chat log from a session (~978) calls it too.
4. `createStudySession` and `getSessionWithExercises` return exercises with `EXERCISE_CLIENT_SELECT`. Enrichment still loads content server-side by itself.
5. Verify no client code reads `topic.content` (`grep -n "topic?.content\|topic.content" src/components`): the voice context is rebuilt in T07; until then the voice effect gets class context through `getClassContextForTopic` (unchanged).
Tests: `getSessionHistory` passes a `select` without `chatLog` (assert on the mocked call); `getSessionDetail` returns the chat log.
Verify: lint/typecheck/vitest/`npm run build`. Browser devtools Network: the response of the history action on page load is under 1 MB (was > 28 MB); opening a past session still shows its chat transcript and score; MIT regression check; Exam check (diagnosis still opens from Analytics).
Commit: `perf: send list fields only and load chat logs and topic content on demand`

#### T07 — Voice context: once per exercise, capped, kept out of the chat log (sonnet)
Depends: T06. Files: new `src/services/voiceContext.ts` (+ test); modify `src/hooks/useLiveAPI.ts`, `src/components/features/StudyInterface.tsx`, `src/app/actions.ts` (new action `getVoiceContextForExercise`).
Steps:
1. `useLiveAPI`: add `sendContext(text: string, opts?: { interrupt?: boolean })`: sends the same `clientContent` turn but does NOT append to `messages`; calls `stopAllAudio()` only when `interrupt` is true. `sendText` stays for real user messages.
2. `buildVoiceContext({ exerciseId, mode })` in `voiceContext.ts`: load the exercise's topic and its class siblings (same course, week, className); exclude topics whose `resourceType` matches `/exercise|solution/i` when `mode === 'exam'`; order by `order` (or `unit`); per-topic cap 6,000 chars, total cap 24,000 chars; returns the context block text (same wording as today, without the answer key in exam mode).
3. `getVoiceContextForExercise(exerciseId, mode)` server action (auth) returns that string. Remove `getClassContextForTopic` usage from `StudyInterface` (keep the action exported if other code uses it; grep).
4. Rewrite the effect (~910–951): dependencies `[currentExercise?.id, liveAPI.isConnected, session?.id, session?.mode, activeTab]`; keep a `lastContextKeyRef` (`<sessionId>:<exerciseId>` or `tab:<name>`) and send only when the key changes; use `sendContext(…, { interrupt: true })` for a new exercise, `{ interrupt: false }` for tab changes. The exam-submitted message in `handleFinishExam` also uses `sendContext`.
5. `saveChatLog`: drop any message whose role is `user` and whose text starts with `[SYSTEM MESSAGE` before saving (cleans old patterns too).
Tests: `buildVoiceContext` excludes solution topics in exam mode, respects caps; hook: `sendContext` does not change `messages` (render the hook with a mocked WebSocket).
Verify: lint/typecheck/vitest/`npm run build`. Browser: connect the voice tutor in a study session, answer two questions; the tutor is not interrupted when an answer is logged; the chat panel shows no `[SYSTEM MESSAGE` entries; finish the session and reopen it from History: transcript has no injected context; check `select length(chatLog) from StudySession order by startTime desc limit 1` is small (a few KB). Exam check with the voice tutor connected: ask "what is the answer?" — the context it has no longer includes the solution topics.
Commit: `fix(voice): send capped exercise context once per question and keep it out of the transcript`

#### T08 — Bug fixes: diagnosis, cancel exam, plan deletion, graded filter, duplicate answers (sonnet)
Depends: T07. Files: `src/app/actions.ts`, `src/components/features/StudyInterface.tsx`, `src/components/features/SessionHistoryList.tsx`, `src/app/actions.test.ts`.
Steps:
1. Exam diagnosis: introduce an inline document mode for the visualizer: `activeFile = 'inline:exam-diagnosis'`; the content-fetch effect skips values starting with `inline:`; `handleFinishExam` sets it together with content and title. (T10 keeps this sentinel when it changes `activeFile` to URLs.)
2. Cancel exam: new action `cancelStudySession(sessionId)` → `status = 'cancelled'`, `endTime = now`, no logs written. The "Cancel Exam" button asks for confirmation (`window.confirm`) and calls it, then clears the active session state. History shows "Cancelled" for such rows; analytics already count only `completed` exams.
3. `deleteStudyPlan`: one `$transaction`: delete `ExerciseLog` and `SessionExercise` rows of the plan's sessions, the sessions, then the plan (explicit, so it works whether or not the adapter enforces foreign keys, U13). `deleteStudySession` also deletes `SessionExercise` rows.
4. Graded filter: replace the text filter in `createStudySession` (~355–370) with `where: { isGraded: true, status: 'active', … }` on the candidate query.
5. `logAnswer`: on Prisma unique violation `P2002` return without error (first attempt wins); same for `handleFinishExam`'s per-exercise logging.
Tests: `deleteStudyPlan` issues the deletes in order inside a transaction; `createStudySession` passes `isGraded: true`; `logAnswer` swallows `P2002` only; `cancelStudySession` writes no logs.
Verify: lint/typecheck/vitest/`npm run build`. Browser: Exam check (diagnosis opens automatically after submit); start an exam and Cancel → no score recorded, history shows Cancelled; double-click an answer in study mode → one log row (`select count(*) from ExerciseLog where sessionId = '<id>'`); study a module in 14.750x or JPAL102x that contains survey-design questions and confirm such questions can appear (compare candidate counts: `select count(*) from Exercise where isGraded = 1`). Plan deletion: in the Study Plan tab create a small plan, open one of its sessions and answer one question, delete the plan → no error, and `select count(*) from ExerciseLog where sessionId not in (select id from StudySession)` → 0.
Commit: `fix: open exam diagnosis, cancel exams without scoring, delete plans with logs, graded flag filter`

### Phase C — Generalize the tutor and harden generation

#### T09 — Prompts module and profile-driven prompts (sonnet)
Added 2026-11-10 (section 5.7): also add `TutorChatMode`, `defaultChatMode` on the profile (with the backward-compatible parse), `chatModeDirective`, and use it at the end of the per-exercise context message and in the exam path. Add a minimal three-way mode selector to `VoiceHub.tsx` (hidden in exam sessions) that sends the switch message with `sendContext`; until T19 there is no `courseId` in the UI, so store the choice under `feynman_chat_mode_legacy`. Tests: directive text per mode; exam always yields the exam directive; old stored profiles parse. Browser check: in each mode, type "Give me a hint for this question" and confirm the reply style differs as specified.
Depends: T08. Files: new `src/lib/ai.ts`, `src/lib/prompts/*.ts`, `src/lib/prompts/prompts.test.ts`, `src/services/studyspaceService.ts` (only `getProfileForCourse`, `getProfileForTopic`, `getCourseWithProfile` here); modify `src/app/actions.ts`, `src/services/summaryService.ts`, `src/services/artifactsService.ts`, `src/components/features/StudyInterface.tsx` (only the `useLiveAPI(...)` argument and the context message builders from T07), `src/services/voiceContext.ts`, `src/app/actions.test.ts`.
Steps:
1. Implement builders from 5.3 for all existing prompts (not the ingestion ones yet). Keep link instructions in the OLD path format in this task (links change in T10) — `fileLinkInstructions()` returns today's text for now.
2. Replace every inline prompt with the builder; load the profile with `getProfileForCourse(topic.courseId)` (falls back to `defaultProfile`). `explainMistake` gains an optional `topicId` argument used to find the profile (it has no callers today; see Backlog).
3. Replace `google('gemini-3.6-flash')` with `textModel()` everywhere in `src/`.
4. `StudyInterface` is still global (no space yet), so pass `voiceSystemInstruction(LEGACY_VOICE_PROFILE)`, where `LEGACY_VOICE_PROFILE` (exported from `legacyProfiles.ts`) has identity "a professor for MIT MicroMasters courses" so the text keeps today's meaning. T19 replaces it with the space profile.
5. Remove `|| "DEDP"` fallbacks (use `'Unknown'`), and the hard-coded planner greeting percentages in `StudyInterface.loadActivePlan` (neutral greeting).
Tests: persona line contains identity/language; `generateExercisePrompt` omits the calibration section when `rigorExamples` is empty; legacy profile prompt still contains the economics guidance; voice instruction contains the five teaching rules.
Verify: `grep -rn "MicroMasters\|DEDP\|MIT " src --include=*.ts --include=*.tsx | grep -v legacy | grep -v test` → nothing; lint/typecheck/vitest; MIT regression check (questions read as before; voice tutor connects).
Commit: `refactor(prompts): build all tutor prompts from the studyspace profile`

#### T10 — File serving by id and new link format (sonnet)
Depends: T09. Files: new `src/lib/fileLinks.ts` (+ test), `src/server/storage.ts` (+ test), `src/app/api/files/topic/[topicId]/route.ts`, `src/app/api/files/source/[sourceId]/route.ts`, `src/app/api/files/summary/route.ts`; modify `src/app/api/file/route.ts`, `src/lib/prompts/*`, `src/app/actions.ts` (diagnosis inputs carry topic ids instead of paths), `src/services/summaryService.ts` (links via `summaryLink`/`sessionSummaryLink`; new index files under `storage/summaries/sessions/`; return `{ link, content }`), `src/services/artifactsService.ts` (`summaryKey` + `summaryLink`; `summaryDirFor`), `src/services/voiceContext.ts` (links via `topicFileLink`), `src/components/features/StudyInterface.tsx` (`handleViewFile` uses `parseFileLink`; `activeFile` holds the URL or an `inline:` sentinel; the content effect fetches the URL and branches on `Content-Type`), `SideVisualizer.tsx`, `VoiceHub.tsx`, `ResourcesDashboard.tsx`.
Route behavior:
- Topic route: auth; load topic; if `sourceId` → stream the source file (`Content-Type` from `Source.mimeType`); else if `localPath` → serve that DB-stored path if it exists (content type by extension as today); else if `content` → `text/plain; charset=utf-8`; else 404. Headers `X-File-Title: encodeURIComponent(title)`, `Content-Disposition: inline`.
- Source route: auth; load source; read `storage/<storageKey>` via `readSourceFile` (rejects keys escaping `STORAGE_DIR`).
- Summary route: auth; `course` + `key` (regex) → `summaryDirFor(course)/<key>.md` (also accept a legacy key already ending in `.md`); `session` → `storage/summaries/sessions/<id>_index.md`, fallback `summaries/session_<id>_index.md`.
- Legacy `/api/file?path=`: keep for saved diagnoses/chat logs, but serve only if `path` equals some `Topic.localPath` (exact `findFirst`) or resolves inside `web/summaries/` or `STORAGE_DIR/summaries/`; else 404.
Tests: `parseFileLink` for all four forms incl. hash and highlight; summary key regex rejects `../x`, `a/b`; `readSourceFile` rejects escaping keys; `isLegacyPathAllowed(path, roots, topicPathExists)` pure function.
Verify: `curl -s -o /dev/null -w "%{http_code}" -b "feynman_session=$APP_PASSCODE" "http://localhost:3000/api/file?path=/etc/hosts"` → 404; same for a real `Topic.localPath` → 200. Browser: Resources → open a slide (PDF, page anchor from a diagnosis link) and a transcript; generate and open a module summary; open an OLD exam diagnosis from history and click an old `/api/file?path=` link; Exam check (inline diagnosis still opens). MIT regression check.
Commit: `feat(files): serve materials by topic/source id and restrict legacy path access`

#### T11 — Replace DEDP-specific logic and extract the exercise generator (sonnet)
Depends: T10. Files: new `src/services/contextSearch.ts` (+ test), `src/services/exerciseGenerator.ts` (+ test); modify `src/app/actions.ts`, `src/app/actions.test.ts`.
Steps:
1. `searchTopics` per 3.6 replaces `getGlobalCourseContext`'s keyword list (keep the exported name as a thin wrapper; exclusion of the calibration module replaces the "comprehensive review" `NOT`).
2. `getPrecedingTopicsContext(topic)` replaces `getPreviousLectureTranscripts`: same course, `order < topic.order`, same `week` first, prefer `resourceType` containing "Transcript" or `sourceId` not null, walk backwards until ≥ 50 chars; same output format. Keep the old exported name as a wrapper `(courseId, className)`. Remove the outline-file reading.
3. `createStudySession`: `isComprehensiveReview` → `topic.week === profile.calibrationModule`.
4. Extract `generateExerciseForTopic` (5.4); delete `determineTargetQuestionType` in favor of `pickQuestionType`.
Tests: `searchTopics` scoring order (mocked prisma); preceding-topic walk; `generateExerciseForTopic` targetType for quantitative/non-quantitative topics; calibration section omitted when `calibrationModule` is null.
Verify: `grep -n "ferraz\|outline.json\|week_06\|comprehensive_review" src/app/actions.ts` → nothing; lint/typecheck/vitest; MIT regression check, plus a session on a Comprehensive Review module draws questions from across the course.
Commit: `refactor(tutor): replace keyword list, week rules and outline file with profile, order and search`

#### T12 — One grading function and server-side exam submission (sonnet)
Depends: T11. Files: new `src/lib/grading.ts`, `src/lib/grading.test.ts`, `src/services/sessionService.ts` (only `submitExam` here); modify `src/components/features/Flashcard.tsx`, `src/components/features/StudyInterface.tsx` (`handleFinishExam`), `src/app/actions.ts` (`logAnswer`, `generateExamDiagnosis`, new exported action `submitExam`).
Grading rules (`gradeAnswer(ex: { exerciseType: string; choices: string | string[]; correctAnswer: string }, userAnswer: string): { score: number; isCorrect: boolean }`), pure and client-safe:
- Normalization: trim, collapse whitespace, lowercase, strip trailing backslashes as today.
- `single_choice`: exact normalized match → 1 else 0.
- `multiple_choice`: correct set from JSON array (fallback: single value); user set from JSON array; score = max(0, (right − wrong) / |correct|); `isCorrect` only when the sets are equal. Items where every choice is correct (survey-style): score 1.
- `numeric`: parse both after removing `,`, spaces, `$`, `%` (a `%` on only one side divides that side by 100 when that makes them comparable); tolerance = max(half a unit of the last decimal place shown in `correctAnswer` (e.g. "-0.07" → 0.005), 1 % of |correct|, 1e-9); correct when |u − c| ≤ tolerance. Non-finite → 0.
- `dropdown`: expected answers from JSON array / single JSON value / `|`-separated string; user answers from a JSON object `{ "[Dropdown 1]": "x" }` or a plain string; strip `[Dropdown n]`/`[Blank n]` prefixes; score = matched expected / total expected; `isCorrect` when all matched and counts equal.
Steps:
1. Flashcard computes immediate feedback with `gradeAnswer`; the server is authoritative: `logAnswer(sessionId, exerciseId, userAnswer, opts?)` loads the exercise, grades, stores `isCorrect` and `score` (signature change; update callers).
2. `submitExam(sessionId, answers: Record<string, string>)`: in one `$transaction`, for each exercise of the session grade and create the log (skip existing ones, P2002), set `status = 'completed'`, `endTime`; return `{ scoreSum, total }`. `handleFinishExam` calls it instead of the client loop and the per-exercise `logAnswer`.
3. `generateExamDiagnosis` uses `log.score` (fallback `gradeAnswer` for legacy logs with null score).
4. Read-only check script in the scratchpad (not committed): grade all existing logs and print how many `isCorrect` values would differ, grouped by type.
Tests: a table with ≥ 30 cases covering every rule above, including legacy answer formats found in the DB (multi-select JSON arrays, dropdown objects with keys, numeric with `%`).
Verify: lint/typecheck/vitest/`npm run build`; the scratchpad report shows differences only for multi-select partial answers and numeric tolerance (list them in the commit body); Exam check (score in results equals the diagnosis score); MIT regression check.
Commit: `fix(grading): single gradeAnswer used by flashcards, logs and transactional exam submission`

#### T13 — Smaller generation context and visible shortfall (sonnet)
Added 2026-11-11 (from T11 testing): (1) `searchTopics`/`getGlobalContext` now returns about 230k characters per call on average (10 topics x up to 50k) and is used as extra grounding for calibration-module generation; this task's caps must bring that down as specified. (2) Generation must not target topics that only hold ungraded material: a Week 13 session produced a generated question about the "required course participation survey". Exclude from the generation pool any topic whose exercises are all `isGraded = false` (and for uploaded content, topics flagged as front matter).
Depends: T12. Files: `src/services/exerciseGenerator.ts`, `src/app/actions.ts` (`generateNextExercise` return type), `src/components/features/StudyInterface.tsx` (~795–822), tests.
Steps:
1. Grounding per 5.4 "Smaller grounding".
2. `generateNextExercise` returns `{ exercise } | { error: string }` instead of `null`.
3. Client: on failure retry the same slot up to 2 times with 2 s / 5 s delays; after 3 consecutive failures stop and show a banner "N of M questions could not be generated" with a Retry button, instead of `setMissingCount(0)`.
Tests: prompt context length ≤ 24,000 + sibling block for a topic with 830k chars of content; sibling summaries included; error result on model failure.
Verify: lint/typecheck/vitest; browser: start a 10-question session with 100 % AI mix in each MIT course and confirm questions keep arriving; temporarily set an invalid `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local`, start a session, see the shortfall banner, restore the key, Retry works. MIT regression check.
Commit: `perf(generation): ground on the target topic with sibling summaries and surface generation shortfalls`

#### T14 — Validate generated questions; report control (sonnet)
Added 2026-11-11 (from T13 testing), required here: (1) Logistics topics pass the eligibility rules: the JPAL102x topic "Welcome to the comprehensive review!" produced a question about exam rules that cannot be answered from its own text. The blind-solve check must reject questions like this; add it as a test case (a question whose answer depends on rules or facts not stated in the question). When a topic's generated questions are rejected repeatedly, stop targeting it for the rest of the session. (2) Math in choices: some generated choices contain bare LaTeX (`\\delta_1 + \\delta_2`) that renders as raw text. Structural validation must require LaTeX in question text and choices to be delimited the way the renderer expects, and must reject LaTeX in `dropdown` options (a `<select>` cannot render math). (3) The "already asked in this session" block of the generation prompt is unbounded (one entry per session question, full text); cap it (most recent 30 questions, 300 characters each).
Depends: T13. Files: new `src/lib/exerciseValidation.ts` (+ test); modify `src/services/exerciseGenerator.ts`, `src/lib/prompts/*` (blind-solve prompt, `GENERATE_EXERCISE_PROMPT_VERSION`), `src/app/actions.ts` (new action `reportExercise(exerciseId, reason)`; selection queries filter `status: 'active'`), `src/components/features/Flashcard.tsx` (a small "Report question" menu item with reasons: wrong answer, unclear, off-topic, other).
Steps: per 5.4 "Validation". Rejected rows are kept with `status = 'rejected'` (for audit; never selected). `reportExercise` sets `status = 'reported'` and `reportedReason`; the card shows "Reported — it won't be shown again".
Tests: structural validator table (each rule pass/fail); generator retries after a blind-solve mismatch and stores the rejected row; report action sets status.
Verify: lint/typecheck/vitest; browser: generate 5 questions (100 % AI) — they arrive; `select status, count(*) from Exercise where createdAt > datetime('now','-1 hour') group by 1` shows `active` and possibly `rejected`; report one question and confirm it is not selected in the next session (`status = 'reported'`). MIT regression check.
Commit: `feat(generation): structural checks, blind-solve validation and question reporting`

#### T15 — Enrichment rework (sonnet)
Depends: T14. Files: `src/app/actions.ts` (`needsContextEnrichment`, `enrichExerciseWithContext`, `createStudySession`), `src/lib/prompts/*` (enrichment prompt input cap), tests.
Steps: enrichment writes `originalQuestionText` (if empty) and `enrichedAt` instead of the marker; context capped at 30,000 chars; leak check per 5.4 (on rejection set `enrichedAt` without changing the text, so it is not retried); at session start enrich at most 5 exercises with concurrency 3 and skip exercises of topics with `sourceId` (uploaded content is enriched in the pipeline, T22) and `origin = 'generated'`. Remove the in-band marker logic (keep stripping it on read for safety).
Tests: leak check rejects an enriched text containing the correct option; cap; no marker written.
Verify: lint/typecheck/vitest; browser: session start time on a fresh MIT module is no slower than before; `select count(*) from Exercise where questionText like '<!-- enriched -->%'` → 0 after a few sessions. MIT regression check.
Commit: `refactor(enrichment): keep original text, cap context, reject answer leaks`

#### T16 — Scope server queries by course (sonnet)
Depends: T15. Files: `src/app/actions.ts`, `src/services/summaryService.ts`, `src/services/artifactsService.ts`, `src/app/actions.test.ts`.
Steps: optional trailing `courseId?: string` (undefined = global, backward compatible) for `getTopics`, `getTopicsWithPerformance`, `getSessionHistory`, `getAnalyticsData`, `getTopicEvolutionData`, `getStudyPlans`, `generateGlobalDiagnosis`, `generatePlannerResponse` (profile only), `generateStructuredStudyPlan` (catalog filtered), `saveAndDeployStudyPlan` (sets plan and session `courseId`), `getCourseArtifacts`. `createStudySession` gains `courseId?: string` as a new last parameter: empty-topic case selects only that course's exercises; the session stores `courseId` (derived from the first topic when not passed). Global diagnosis row found/created per `courseId`. Order topics by `[{ order: 'asc' }, { week: 'asc' }]`.
Tests: `createStudySession` stores courseId; scoped `getSessionHistory` filters by courseId.
Verify: lint/typecheck/vitest; MIT regression check via `/study`; newest session has a courseId.
Commit: `feat(studyspace): scope topics, sessions, plans, analytics and summaries by course`

### Phase D — Server-owned sessions

#### T17 — Server-owned session state (sonnet)
Depends: T16. Files: `src/services/sessionService.ts` (+ test), `src/app/actions.ts` (thin exported actions), `src/components/features/StudyInterface.tsx` (~286–460 restore/save logic, ~795–840 generation and timer), `src/components/features/Flashcard.tsx` (draft/flag callbacks unchanged in shape).
API (all actions call `requireAuth`):
```ts
startSession(input: { courseId?: string; topicIds: string[]; count: number; mode: 'study' | 'exam'; timeLimit: number | null; sourcingMix: number; weakPct: number; unstudiedPct: number; expertPct: number }): Promise<SessionState>
getActiveSession(courseId?: string): Promise<SessionState | null> // latest status 'active' session; plan-precreated sessions only if they have a log or a draft
getSessionState(sessionId: string): Promise<SessionState>         // finalizes an exam whose deadline passed more than 30 s ago (submitExam with stored drafts)
saveDraft(sessionId: string, exerciseId: string, draftAnswer: string | null, timeSpentDeltaSec: number): Promise<void> // rejects after deadline + 30 s
setFlagged(sessionId: string, exerciseId: string, flagged: boolean): Promise<void>
setCurrentPosition(sessionId: string, position: number): Promise<void>
submitExam(sessionId: string, answers?: Record<string, string>): Promise<{ scoreSum: number; total: number }> // uses stored drafts when answers omitted
type SessionState = { session: { id, courseId, title, mode, status, timeLimit, deadline, targetCount, topicIds: string[], currentPosition, sourcingMix }, items: { position, exercise /* EXERCISE_CLIENT_SELECT */, draftAnswer, flagged, log: { isCorrect, score, userAnswer } | null }[], missingCount: number, serverNow: string }
```
Steps:
1. `createStudySession` becomes `startSession` (keep the old name as an alias export until callers are updated in this task, then remove): writes `topicIds`, `targetCount`, `deadline = now + timeLimit` for exams, and `SessionExercise` rows (positions 0..n−1). Stops writing `exerciseIds`.
2. `generateNextExercise` appends a `SessionExercise` in a transaction (`position = max + 1`; retry once on unique conflict). No more read-modify-write of `exerciseIds`.
3. All readers (`getSessionWithExercises`, `createSessionSummary`, diagnosis, analytics) read items from `SessionExercise`.
4. Client: remove the localStorage session snapshot. Keep only `feynman_active_session_<courseId|global>` = session id as a hint; on mount call `getActiveSession(courseId)` (the hint is used only if it is still active). Legacy key `dedp_active_session`: read its `session.id` once, use it as the hint, delete the key. `selectedTopics` restored from `session.topicIds`. Drafts/flags call `saveDraft`/`setFlagged` (debounced 500 ms for typing in numeric fields). Navigation calls `setCurrentPosition` (debounced). Chat log saved via `saveChatLog` debounced every 15 s during a session.
5. Timer: remaining = `deadline − (Date.now() + (serverNow − clientNowAtFetch))`; at 0 call `submitExam`. Server finalizes overdue exams in `getSessionState`.
6. `missingCount` comes from the server (`targetCount − items.length`).
Tests: start creates items and deadline; append is positional and conflict-safe; overdue exam finalizes with drafts; `getActiveSession` ignores untouched plan sessions; `saveDraft` rejected after deadline.
Verify: lint/typecheck/vitest/`npm run build`. Browser: start a 5-question exam, answer 2, flag 1, reload → same question, drafts, flag and remaining time; open the same URL in a second browser (or a private window after login) → the same session resumes; let a 1-minute exam run out with the tab closed, reopen → it is submitted with the saved drafts. Study session: reload mid-session, generation continues to the target count. MIT regression check; Exam check.
Commit: `feat(sessions): server-owned session state with resumable sessions and a server-side exam deadline`

#### T18 — Real answer time and assisted flag (sonnet)
Depends: T17. Files: `src/components/features/Flashcard.tsx`, `src/components/features/StudyInterface.tsx`, `src/services/sessionService.ts`, `src/app/actions.ts` (`logAnswer` opts `{ durationSec, assisted }`), tests.
Steps: Flashcard measures visible time per card (start on mount/when shown, pause on `document.visibilityState === 'hidden'`, resume on visible); passes `durationSec` (rounded, capped at 3,600) on answer. `assisted` = the user clicked a help/explain control, or sent a voice/text message to the tutor, while this card was current and unanswered (StudyInterface keeps `assistedRef[exerciseId]`). Exam: visible time accumulates into `SessionExercise.timeSpentSec` via `saveDraft` deltas; `submitExam` writes it as `duration`. Remove the hard-coded `30`.
Tests: timer pauses while hidden (fake timers + visibility events); assisted flag set only before answering.
Verify: lint/typecheck/vitest; browser: answer a card after ~20 s → `select duration, assisted from ExerciseLog order by timestamp desc limit 1` ≈ 20, 0; ask the tutor before answering the next one → assisted 1. MIT regression check.
Commit: `feat(sessions): record visible answer time and tutor assistance`

### Phase E — Spaces UI for existing courses and phone study flow

#### T19 — `/spaces` list and `/spaces/[id]` study route (sonnet)
Depends: T18. Files: new `src/app/spaces/page.tsx`, `src/app/spaces/[id]/page.tsx`, `src/app/spaces/actions.ts` (only `listStudyspacesAction`, `getProfileAction`, `renameStudyspaceAction` here; add the module to `actions.auth.test.ts`), `src/components/features/spaces/SpaceCard.tsx` (+ test); modify `src/app/page.tsx` (authenticated → `redirect('/spaces')`; keep login UI; remove MIT copy), `src/app/study/page.tsx` (→ `redirect('/spaces')`), `StudyInterface.tsx`, `ConfigureSessionDialog.tsx` (+ test), `ResourcesDashboard.tsx`, `AnalyticsDashboard.tsx` (labels only).
Steps:
1. `StudyInterface` props `{ courseId: string; courseTitle: string; profile: TutorProfile }`; pass `courseId` to every scoped action; `useLiveAPI(voiceSystemInstruction(profile))`; active-session hint key `feynman_active_session_<courseId>`; header link "← Studyspaces" and the space title.
2. `/spaces/[id]/page.tsx`: server component; `await params`; auth guard (redirect `/`); load course; `parseProfile(course.profile) ?? defaultProfile(course)`; `notFound()` if missing; `export const dynamic = 'force-dynamic'`.
3. `/spaces/page.tsx`: auth guard, grid of `SpaceCard` (title, goal, topics, exercises, last studied, source status badges). The "New studyspace" card is added in T25 with the wizard.
4. ConfigureSessionDialog: hide the course filter when only one course is present; "Week" → "Module"; question counts 5, 10, 20, 50 plus `profile.examPreset` (new prop `examPreset`).
5. "Week" → "Module" in ResourcesDashboard/Analytics labels (display only).
Tests: ConfigureSessionDialog renders the exam preset and "Module"; SpaceCard renders counts.
Verify: lint/typecheck/vitest/`npm run build`; `/` after login → `/spaces` with two cards; MIT regression check in both spaces; data isolated per space (history, analytics, plans, resources, active session); `/study` redirects; `npm run build && npm run start -- -p 3001` and log in on `http://127.0.0.1:3001` with Chrome (R6).
Commit: `feat(spaces): studyspace list and per-space study route with scoped data and voice persona`

#### T20 — Phone study flow: confirm answers, tutor bottom sheet (sonnet)
Added 2026-11-11 (from T19 testing), required here: (1) At 375 px the six-tab strip is clipped: the last tab reads "Analytic" and the strip does not scroll. Make the tab strip fit or scroll horizontally at phone width, with every tab fully readable and reachable. (2) When generation ends with a terminal error and the session has no questions at all (for example a selection that turns out to be only course logistics), the student is left in an empty active session showing the banner plus "No exercises found for this selection." and must press End Session. End such a session automatically (no answers exist to lose), return to the start screen and show the message there. (3) The planner's "Suggested Pre-Ideas" prompts still name MIT topics ("Sampling and Leaders", "Logistics and Ethics", "OLS, Voting"); derive them from the studyspace's own modules or remove them.
Added 2026-11-11 (from T18 testing): the card header shows the topic title, which for imported question topics is just "Question 6" ("14.750x - Question 6" while the session counter says "Question 3 of 10"). Show the module and class instead (for example "Week 1 · Introduction to Political Economy"), not the source question number.
Added 2026-11-11 (from T17 testing), required here: in exam mode a multi-select answer is only stored when "Save Answer" is clicked; ticking boxes and moving on loses the answer (a tester lost one this way). Save the draft on every toggle (through the existing debounced draft writer) and remove the need for a separate save button in exams; the "N of M answered" counter must update from it.
Added 2026-11-10 (section 5.7): the bottom sheet carries the chat mode selector; from T19 on the choice is stored per studyspace (`feynman_chat_mode_<courseId>`, migrating `feynman_chat_mode_legacy`).
Depends: T19. Files: `src/components/features/Flashcard.tsx` (+ test), `src/components/features/StudyInterface.tsx`, new `src/components/features/TutorSheet.tsx` (+ test).
Steps:
1. Flashcard (study mode): tapping a single-choice option selects it; a "Check answer" button commits (same as the multi-select/numeric/dropdown submit). Exam mode keeps saving the draft on selection (drafts are not commits).
2. Below `xl`: remove the "Tutor" tab; render a floating "Tutor" button that opens `TutorSheet` (fixed bottom sheet, ~65 vh, close button, Escape closes, focus trapped; contains `VoiceHub`). The card stays visible above the sheet. At `xl` and above the sidebar layout is unchanged. The "History" tab stays.
Tests: Flashcard single choice does not call `onAnswer` until "Check answer"; TutorSheet opens/closes and renders VoiceHub.
Verify: lint/typecheck/vitest; browser with devtools device emulation (iPhone width 390 px): select, change, confirm an answer; open the tutor sheet during a card, talk, close it; no horizontal scroll. Desktop layout unchanged. MIT regression check.
Commit: `feat(mobile): select-then-confirm answers and a tutor bottom sheet on small screens`

### Phase F — Upload pipeline

#### T21 — Storage, Source service, extraction (sonnet)
Depends: T20. Files: new `src/server/ingest/schemas.ts`, `src/server/ingest/extract.ts` (+ test), extend `src/server/storage.ts`.
Steps: 4.1 limits as exported constants; 4.4 extraction: `extractSource(sourceId): Promise<{ pageCount: number; charCount: number; ocr: boolean }>`. Pure helpers: `splitTextIntoPages(text, { markdown: boolean, target = 4000 })`, `isSparse(pages)`, `pageRanges(pageCount, size = 15)`.
Tests: splitting keeps all text, respects markdown headings; `isSparse` thresholds; PDF path with `pdf-parse` mocked; OCR path with `generateObject` mocked; 2,000,001-char input fails with the documented message.
Verify: lint/typecheck/vitest (end-to-end check happens in T23); MIT regression check (quick).
Commit: `feat(ingest): source storage and text/PDF extraction with Gemini fallback`

#### T22 — Segmentation, question import, imported-question enrichment (sonnet)
Depends: T21. Files: new `src/server/ingest/segment.ts` (+ test), `src/server/ingest/importQuestions.ts` (+ test), prompt builders in `src/lib/prompts/ingest.ts`.
Zod (in `schemas.ts`):
```ts
export const TopicSegmentSchema = z.object({
  title: z.string(), pageStart: z.number().int(), pageEnd: z.number().int(),
  summary: z.string(), keyTerms: z.array(z.string()), isQuantitative: z.boolean(),
})
export const SegmentationOutputSchema = z.object({ modules: z.array(z.object({ title: z.string(), topics: z.array(TopicSegmentSchema) })) })
export const WindowTopicsSchema = z.object({ topics: z.array(TopicSegmentSchema.extend({ moduleHint: z.string() })) })
export const ModuleGroupingSchema = z.object({
  modules: z.array(z.object({ title: z.string(), topicIndices: z.array(z.number().int()) })),
  mergeGroups: z.array(z.array(z.number().int())),
})
export const ImportedQuestionSchema = z.object({
  questionText: z.string(), exerciseType: z.enum(['single_choice','multiple_choice','numeric','dropdown']),
  choices: z.array(z.string()), correctAnswer: z.string(), explanation: z.string(),
})
export const ImportedQuestionsSchema = z.object({ questions: z.array(ImportedQuestionSchema) })
export const OcrPagesSchema = z.object({ pages: z.array(z.object({ n: z.number().int(), text: z.string() })) })
```
Functions: `segmentSource(sourceId): Promise<{ topicIds: string[] }>` (4.5), `normalizeSegments(...)`, `buildWindows(pages, maxChars = 60000)`, `importQuestionsForSource(sourceId): Promise<{ imported: number }>` (validates each with `validateExerciseStructure`, sets `origin = 'imported'`, `isGraded = true`, then enriches per 4.6), `looksLikeQuestions(text)`.
Tests: `buildWindows` on an 830k-char synthetic page set → 14 windows, contiguous, 1-page overlap; `normalizeSegments` fixes gaps/overlaps/out-of-range/caps; windowed path with mocked `generateObject` yields modules in page order; import keeps only answered and structurally valid questions; `.md` edX format uses `parseExerciseMarkdown` without an LLM call; enrichment leak check applied.
Verify: lint/typecheck/vitest; app still runs.
Commit: `feat(ingest): windowed segmentation into modules/topics and validated question import`

#### T23 — Runner, upload route, boot resume, starter stage for later uploads (sonnet)
Depends: T22. Files: new `src/server/ingest/runner.ts` (+ test), `src/instrumentation.ts`, `src/app/api/spaces/[id]/sources/route.ts`; extend `src/app/spaces/actions.ts` (`createStudyspaceAction`, `getSpaceStatusAction`, `retrySourceAction`, `removeSourceAction`, `deleteStudyspaceAction`), `src/services/studyspaceService.ts`.
Steps:
1. Runner per 4.3 with jobs `source` and `starters`. Source stages per 4.2: `generating_exercises` only when the course has an accepted profile; otherwise `ready` and `Course.starterStatus = 'waiting_for_profile'` (if it is null). The `starters` job (`generateStarters(courseId)`) is implemented here and unit-tested but only triggered from T25 (`acceptProfileAction`); resume picks up `pending`/`running` courses.
2. Upload route `POST /api/spaces/[id]/sources`: auth (401); `await params`; `await request.formData()`; field `files` (multiple) and `bundle` (`initial`|`later`); validate all files (4.1) before writing anything; write via `writeSourceFile`; create `Source` rows; enqueue; respond `201 { sources: [{ id, originalName, status }] }`. Enforce 50 MB with `file.size`. Add `export const runtime = 'nodejs'` if the docs read in T01 require it.
3. `src/instrumentation.ts`: `register()` → when `process.env.NEXT_RUNTIME === 'nodejs'`, dynamic-import the runner and `void resumePendingSources()`.
4. `deleteStudyspaceAction(id, confirmTitle)`: refuses unless `confirmTitle === title`; deletes the course (cascades, 3.1) in one call, then `rm -rf storage/sources/<id>` and `storage/summaries/<id>`.
Tests: stage order with mocked stages; resume from `segmenting`; failure sets `failedStage` + `error`; lease prevents double processing; new space skips `generating_exercises` and sets `waiting_for_profile`; later upload with a profile runs it; upload validation (415, 413, 401); delete refuses without the exact title.
Verify: lint/typecheck/vitest/`npm run build`. Manual end-to-end (no UI yet):
1. Back up, then create an empty space: `sqlite3 dev.db "insert into Course (id, code, title, createdAt) values ('t23-test', 't23-test', 'T23 test', CURRENT_TIMESTAMP);"`.
2. `curl -s -b "feynman_session=$APP_PASSCODE" -F "files=@<small .md or .pdf>" -F bundle=initial http://localhost:3000/api/spaces/t23-test/sources` → 201.
3. Poll `sqlite3 -readonly dev.db "select status, error, pageCount from Source where courseId='t23-test'; select starterStatus from Course where id='t23-test'; select count(*) from Topic where courseId='t23-test';"` → `ready`, `waiting_for_profile`, topics > 0, no starter exercises.
4. Upload a larger PDF, stop the dev server during `segmenting`, restart, confirm it reaches `ready`.
5. Delete the test space via a vitest-free path: `sqlite3 dev.db "delete from Course where id='t23-test'"` (cascades) and `rm -rf storage/sources/t23-test`; confirm `select count(*) from Topic where courseId='t23-test'` → 0.
MIT regression check (quick).
Commit: `feat(ingest): background runner with restart resume and upload endpoint`

#### T24 — Wizard: create, upload, processing, outline review (sonnet)
Added 2026-11-11 (from T23, as built and as tested):
- T23 interfaces to build on: `createStudyspaceAction`, `getSpaceStatusAction`, `retrySourceAction`, `removeSourceAction`, `deleteStudyspaceAction(id, confirmTitle)` return `{ ok: true, ... } | { ok: false, reason }` (show `reason` as is). The upload route answers `201 { sources: [{ id, originalName, status, sizeBytes, nameAlreadyInSpace }] }`, or `{ error, files: [{ name, error }] }` with 400/413/415; a request is refused as a whole when one file is bad, and is capped at 200 MB, so the dropzone sends one file per request and shows the per-file error. `removeSourceAction` can answer "being processed right now, try again in a minute".
- Upload returns before processing; `uploaded`/`extracting` pass within seconds, `segmenting` takes 30 s to 2 min per file. The processing view must make clear that the page can be closed and work continues (it also resumes after a server restart, measured about 2 min to `ready`).
- Opening an uploaded PDF topic showed page 1 instead of the topic's first page: the viewer link is built without `page`. Pass `pageStart` through `topicFileLink(topicId, { page })` wherever an uploaded topic is opened (this is the "a topic opens at its start page" check below).
- Opening a topic of an uploaded `.md`/`.txt` showed the whole file from the top. For text sources show the topic's own `content` (not the original file) in the viewer.
- At 375 px the resource viewer overlay covers the module list and has to be closed before another topic can be opened; check it has a visible close control.
Depends: T23. Files: new `src/app/spaces/new/page.tsx`, `src/app/spaces/[id]/setup/page.tsx`, `src/components/features/spaces/NewSpaceForm.tsx`, `SourceDropzone.tsx`, `ProcessingView.tsx`, `OutlineEditor.tsx` (+ tests); extend `src/app/spaces/actions.ts` (outline actions from 5.6); modify `src/app/spaces/page.tsx` (add the "New studyspace" card).
Steps:
1. `/spaces/new`: name (required, ≤ 80) + goal (optional, ≤ 300) → `createStudyspaceAction` → `/spaces/<id>/setup?step=upload`.
2. Setup page reads `searchParams` (Promise — confirm in docs) and renders: `upload` (drag & drop + file input, `.txt,.md,.pdf`, client-side checks, `fetch` + `FormData`) → `processing` (polls `getSpaceStatusAction` every 2 s; per file: status, pages, error with Retry/Remove) → `outline` when all initial sources are terminal (OutlineEditor: modules with topics; inline rename; merge 2+ adjacent topics of one source; up/down reorder of topics and modules; move topic to another module; each action calls the server action and refetches). In this task the outline step's primary button is "Start studying" → `/spaces/<id>` (sessions generate questions on the fly with `defaultProfile`); T25 inserts the persona step.
3. `/spaces/[id]`: if the space has no topics, redirect to `/setup`.
Tests: OutlineEditor merge only for adjacent same-source topics; reorder emits the right ids; dropzone rejects `.docx` and > 50 MB.
Verify: lint/typecheck/vitest/`npm run build`. Browser: create "Test space", upload a `.md`, a text PDF and (if available) a scanned PDF; statuses reach `ready`; restart during processing resumes; rename/merge/reorder persist after reload; "Start studying" opens the space; a session draws questions from the uploaded material; a topic opens at its start page. MIT regression check.
Commit: `feat(spaces): new-studyspace wizard with upload, processing status and outline editor`

#### T25 — Persona proposal, card, and starter exercises after acceptance (sonnet)
Added 2026-11-10 (section 5.7): the proposal includes `defaultChatMode`, and the persona card shows it as an editable field next to the tone preset.
Added 2026-11-11 (from T23): register the proposal with `onSourceTerminal('profileProposal', hook)` from `src/instrumentation.ts` (hooks live on the shared runner state, keyed by name, so the registration is seen by every bundle and survives hot reload); do not edit the runner loop. `acceptProfileAction` calls `requestStarters(courseId)` from the runner (it moves `waiting_for_profile`/`failed` → `pending` and queues the job, once).
Depends: T24. Files: new `src/server/ingest/profileProposal.ts` (+ test), `src/components/features/spaces/PersonaCard.tsx` (+ test), `src/lib/prompts/profile.ts`; modify `src/server/ingest/runner.ts` (call `maybeProposeProfile` after terminal source states), `src/app/spaces/actions.ts` (`regenerateProfileAction`, `acceptProfileAction`, `dismissProfileSuggestionAction`, `splitStudyspaceAction`), setup page (persona step after outline).
Steps:
1. `proposeProfile(courseId)`: outlines + samples of ready sources, failed ones in `excludedSources`, `generateObject(ProfileProposalSchema)`, fill `version`, `calibrationModule: null`, `examPreset: null`, `questionTypeCycles: null`; normalize mixes; `split` when `!subjectsCoherent` with ≥ 2 groups.
2. `maybeProposeProfile` and `suggestProfileUpdate` per 4.6.
3. PersonaCard per decision 5 (presets, editable fields, optional difficulty module and exam preset, excluded-files banner, split notice with "Split into two studyspaces" / "Keep together").
4. `acceptProfileAction`: validate, write `profile`, clear suggestion; if `starterStatus === 'waiting_for_profile'` set `pending` and `enqueueStarters(courseId)`. The setup page then shows "Preparing starter questions…" with progress (topics with ≥ 1 exercise / total) and a "Start studying now" button that does not wait.
Tests: proposal excludes failed sources; mixes normalized; split only when incoherent; accept enqueues starters exactly once; PersonaCard preset changes tone/notes; Accept sends a schema-valid profile.
Verify: lint/typecheck/vitest/`npm run build`. Browser: new space with 2 related files → no exercises exist before accepting (`select count(*) from Exercise e join Topic t on t.id=e.topicId where t.courseId='<id>'` → only imported ones); accept → starters appear, `starterStatus` reaches `done`; the voice tutor uses the identity; a mixed-subject upload shows the split notice and splitting works; a broken file is named as left out. MIT regression check.
Commit: `feat(persona): propose and accept the tutor profile, then generate starter questions with it`

#### T26 — Later uploads and suggested profile updates (sonnet)
Added 2026-11-11 (from T22 testing), required before phase F is closed: question import works per topic, so when segmentation puts a quiz's questions and its answer key in different topics of the same source (seen on a 3-page quiz PDF: questions on pages 1-2, key on page 3), nothing is imported. When a topic of a source carries an answer cue but no questions, pair it with the question topics of that source (pass the key topic's text as an additional answer source) before giving up. Also: uploaded text files that are saved web pages can be mostly HTML and script boilerplate (a crawler `.txt` was 94% boilerplate), which ends up in `Topic.content`; strip script/style blocks and tags from `.txt`/`.md` input that is evidently HTML, or reject it with a clear message.
Added 2026-11-11 (from T23 testing): `.md`/`.txt` files are cut into pseudo-pages of a fixed character size (`TEXT_PAGE_CHARS`), and topics are whole pages, so a short section cannot become its own topic: a 2,400-word Markdown file gave 4 topics of one page each, with its "Course logistics" section merged into the first content topic and never flagged as not study material. For Markdown, start a new pseudo-page at `#`/`##` headings (merge very short sections with the next one, keep the size cap), so sections can be separated and logistics isolated.
Depends: T25. Files: new `src/components/features/spaces/ProfileSuggestionBanner.tsx` (+ test); modify `StudyInterface.tsx` ("Add files" in the Resources tab header with `SourceDropzone bundle='later'` and a compact status list; banner when `profileSuggestion.kind === 'update'`), `ResourcesDashboard.tsx` (uploaded sources and topics; open via `topicFileLink`), `src/app/spaces/[id]/page.tsx`.
Steps: later uploads run the full pipeline including `generating_exercises` (profile exists); new topics appended after the current max `order` as new modules; banner shows rationale and changed fields with Accept / Ignore; never automatic.
Tests: banner renders only for `kind: 'update'`; Ignore calls dismiss.
Verify: lint/typecheck/vitest/`npm run build`. Browser: add a file to the test space → topics and starter questions appear; Ignore leaves the profile unchanged; add a small file to the 14.750x space → MIT space still works, profile unchanged unless accepted. MIT regression check.
Commit: `feat(spaces): add files to an existing studyspace with opt-in persona update`

### Phase G — Phone access and service

#### T27 — Web app manifest and home-screen metadata (haiku)
Depends: T26. Files: new `src/app/manifest.ts`, `public/icon-192.png`, `public/icon-512.png` (`sips -z 192 192 public/logo.png --out public/icon-192.png`, same for 512), modify `src/app/layout.tsx` (`metadata.appleWebApp = { capable: true, title: 'Feynman', statusBarStyle: 'default' }`; `export const viewport` with `themeColor` if the docs confirm it).
Manifest: name "Feynman Study Hub", short_name "Feynman", start_url "/spaces", display "standalone", colors from `globals.css` tokens, icons 192/512.
Verify: lint/typecheck/vitest/`npm run build`; `curl -s http://localhost:3000/manifest.webmanifest` returns JSON (confirm the path in docs); devtools Application → Manifest without errors. MIT regression check (quick).
Commit: `feat(pwa): add web app manifest and home-screen icons`

#### T28 — Phone access toggle via Tailscale serve (sonnet)
Depends: T27. Files: new `src/server/phoneAccess.ts` (+ test), `src/server/requestOrigin.ts` (+ test), `src/app/api/phone-access/route.ts`, `src/components/features/spaces/PhoneAccessCard.tsx`; modify `src/app/spaces/page.tsx`, `next.config.ts`, `package.json` (add `qrcode`, `@types/qrcode`).
Design:
- Binary resolution order: `process.env.TAILSCALE_BIN`, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale` (unconfirmed). First existing executable wins. `execFile` (no shell), timeout 15 s.
- `getPhoneAccessStatus(port)`: `tailscale status --json` → missing binary → `not_installed`; non-zero exit or `BackendState !== 'Running'` → `tailscale_not_running`; else `dnsName = Self.DNSName` minus trailing dot. `tailscale serve status --json` → `on` if the JSON contains a proxy target for `127.0.0.1:<port>` or `localhost:<port>` (string search, not a fixed path); return `{ state, url: 'https://' + dnsName }`.
- `enablePhoneAccess(port)`: `tailscale serve --bg --https=443 --yes localhost:<port>`; `disablePhoneAccess()`: `tailscale serve --https=443 off`. On timeout or output containing a `login.tailscale.com`/admin URL → `{ ok: false, needsConsent: true, message }` telling the owner to run `tailscale serve --bg --https=443 localhost:<port>` once in Terminal.
- `port` = `process.env.PORT ?? 3000`.
- `isLocalRequest(headers)`: host is `localhost`/`127.0.0.1`/`[::1]` (any port) AND no `tailscale-user-login` header (Serve sets it for tailnet users and strips spoofed copies) AND no `x-forwarded-for`/`x-forwarded-host`. GET status for any authenticated request (includes `canToggle`); POST requires `isLocalRequest`, else 403.
- QR: `QRCode.toString(url, { type: 'svg' })` in the GET payload when `on`.
- `next.config.ts`: keep `bodySizeLimit: '10mb'`; add `serverActions.allowedOrigins` from `process.env.PHONE_ACCESS_HOST` when set; keep the ngrok `allowedDevOrigins` until T30.
- Card: status pill, toggle (disabled with the reason when `canToggle` is false or Tailscale is missing), URL + QR when on, refresh.
Tests: binary resolution order; status parsing fixtures (assumed shapes) for not-installed, stopped, running+off, running+on; `isLocalRequest` truth table; POST with `host: x.ts.net` → 403.
Verify: lint/typecheck/vitest/`npm run build`. Browser on the Mac: card shows "Tailscale not installed", toggle disabled. `curl -X POST -H "Host: foo.ts.net" -b "feynman_session=$APP_PASSCODE" http://localhost:3000/api/phone-access` → 403. MIT regression check (quick).
Commit: `feat(phone): phone access toggle with tailscale serve status, URL and QR`

#### T29 — launchd agent files and install/uninstall scripts (haiku)
Depends: T28. Files: new `scripts/launchd/com.feynman.studyhub.plist.template`, `scripts/launchd/install.sh`, `scripts/launchd/uninstall.sh`; modify `web/README.md` (short "Run as a background service" section).
Template (placeholders `__NODE__`, `__WEB_DIR__`, `__PORT__`, `__LOG_DIR__`, `__PATH__`):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.feynman.studyhub</string>
  <key>ProgramArguments</key><array>
    <string>__NODE__</string>
    <string>__WEB_DIR__/node_modules/next/dist/bin/next</string>
    <string>start</string><string>-H</string><string>127.0.0.1</string><string>-p</string><string>__PORT__</string>
  </array>
  <key>WorkingDirectory</key><string>__WEB_DIR__</string>
  <key>EnvironmentVariables</key><dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PORT</key><string>__PORT__</string>
    <key>PATH</key><string>__PATH__</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>__LOG_DIR__/out.log</string>
  <key>StandardErrorPath</key><string>__LOG_DIR__/err.log</string>
</dict></plist>
```
`install.sh` (bash, `set -euo pipefail`, supports `--dry-run`): resolve `WEB_DIR` from the script location; `NODE=$(command -v node)` (abort if empty); `PORT=${PORT:-3000}`; `LOG_DIR=$HOME/Library/Logs/feynman-studyhub`; refuse if the port is in use (`lsof -iTCP:$PORT -sTCP:LISTEN`); `npm run build`; render the template with `sed` into `$HOME/Library/LaunchAgents/com.feynman.studyhub.plist`; `plutil -lint`; `launchctl bootout gui/$(id -u)/com.feynman.studyhub 2>/dev/null || true`; `launchctl bootstrap gui/$(id -u) <plist>`; print `launchctl print gui/$(id -u)/com.feynman.studyhub | head -20` and the URL. `--dry-run` prints the rendered plist and the commands without building or calling launchctl. `uninstall.sh`: `launchctl bootout …|| true`; remove the plist; keep logs. Both `chmod +x`.
README notes: production binds 127.0.0.1; stop the service before `npm run dev` on the same port and DB; re-run `install.sh` after pulling code or changing the node version.
Verify (no install): `bash -n` both scripts; `scripts/launchd/install.sh --dry-run > <scratch>/rendered.plist` and `plutil -lint` it; lint/typecheck/vitest unaffected.
Commit: `chore(service): add launchd user agent template and owner-run install/uninstall scripts`

#### T30 — Remove the ngrok origin (haiku) — gated
Depends: T29 and the owner's confirmation that phone access works (section 9, step 7). Files: `next.config.ts` (remove the ngrok `allowedDevOrigins`; if the owner wants dev access from the phone, use `process.env.PHONE_ACCESS_HOST`).
Verify: lint/typecheck/`npm run build`; MIT regression check; owner re-checks phone access.
Commit: `chore(config): remove ngrok dev origin in favor of tailscale serve`

---

## 7. Order and per-phase verification

Linear order: T01 → T02 → … → T30 (T30 gated on the owner).

| ID | Title | Model |
|---|---|---|
| T01 | Environment setup and baseline | haiku |
| T02 | Schema, indexes, delete rules and migration adoption | sonnet |
| T03 | Profile types, legacy profiles, backfill | sonnet |
| T04 | Auth on every server action; production bound to localhost | haiku |
| T05 | Gemini Live ephemeral tokens | sonnet |
| T06 | Trim server payloads | sonnet |
| T07 | Voice context once per exercise, capped, out of the chat log | sonnet |
| T08 | Bug fixes: diagnosis, cancel exam, plan deletion, graded filter, duplicate answers | sonnet |
| T09 | Prompts module and profile-driven prompts | sonnet |
| T10 | File serving by id and new link format | sonnet |
| T11 | Replace DEDP-specific logic; extract the exercise generator | sonnet |
| T12 | One grading function and server-side exam submission | sonnet |
| T13 | Smaller generation context and visible shortfall | sonnet |
| T14 | Validate generated questions; report control | sonnet |
| T15 | Enrichment rework | sonnet |
| T16 | Scope server queries by course | sonnet |
| T17 | Server-owned session state | sonnet |
| T18 | Real answer time and assisted flag | sonnet |
| T19 | `/spaces` list and `/spaces/[id]` route | sonnet |
| T20 | Phone study flow: confirm answers, tutor bottom sheet | sonnet |
| T21 | Storage, Source service, extraction | sonnet |
| T22 | Segmentation, question import, imported-question enrichment | sonnet |
| T23 | Runner, upload route, boot resume | sonnet |
| T24 | Wizard: create, upload, processing, outline review | sonnet |
| T25 | Persona proposal, card, starters after acceptance | sonnet |
| T26 | Later uploads and suggested profile updates | sonnet |
| T27 | Web app manifest | haiku |
| T28 | Phone access toggle via Tailscale serve | sonnet |
| T29 | launchd agent files and scripts | haiku |
| T30 | Remove the ngrok origin (gated) | haiku |

Sonnet: 25 tasks. Haiku: 5 tasks (T01, T04, T27, T29, T30).

Phase checklists (in addition to each task's Verify):
- **A (T01–T03)**: row counts as in 3.2 step 7 (734 logs after dedupe); `prisma migrate status` clean; backups in `backups/`; app behaves as before.
- **B (T04–T08)**: unauthenticated action calls fail; production listens on 127.0.0.1 only; no API key in the browser (or the documented exception); history payload < 1 MB; voice transcript free of injected context; exam diagnosis opens; cancel does not score; graded filter in place.
- **C (T09–T16)**: no MIT/DEDP literals outside legacy files; `/api/file` refuses arbitrary paths; one grader everywhere; generated questions carry `origin/status/promptVersion`; no enrichment marker; new sessions carry `courseId`; Exam check.
- **D (T17–T18)**: a session resumes after reload and in a second browser; exam deadline enforced by the server; durations are real.
- **E (T19–T20)**: `/` → `/spaces`; spaces isolated; phone-width flow works; `npm run build && npm run start -- -p 3001` works.
- **F (T21–T26)**: full wizard with txt, md, text PDF, scanned PDF and a failing file; restart resumes; no starter questions before persona acceptance; split works; later upload with suggestion; MIT spaces untouched.
- **G (T27–T30)**: manifest valid; phone card states correct without Tailscale; scripts lint; after owner steps: phone opens the ts.net URL, logs in, studies, voice works over HTTPS, server actions succeed (no "Invalid Server Actions request" in `~/Library/Logs/feynman-studyhub/err.log`).

---

## 8. Risks, assumptions, unconfirmed items

Confirmed against Next.js 16.2.x docs (context7, v16.2.9 docs; re-check against installed 16.2.12 in T01):
- `experimental.serverActions.allowedOrigins` (array, wildcard subdomains allowed) and `bodySizeLimit`.
- `after` from `next/server` usable in Route Handlers and Server Functions.
- `params` is a Promise in pages and route handlers (`await params`).
- `instrumentation.ts` `register()` runs once per server start; gate with `process.env.NEXT_RUNTIME === 'nodejs'`.
- `app/manifest.ts` returning `MetadataRoute.Manifest`.
- `next start` options `-p`, `-H` (default hostname 0.0.0.0 — hence `-H 127.0.0.1`).
- `experimental.proxyClientMaxBodySize` (default 10 MB) applies only when a `proxy` file exists; the app has none.

Confirmed against Gemini docs (2026-11-10): Live API ephemeral tokens exist (`v1beta` `auth_tokens`, `uses`, `expireTime`, `newSessionExpireTime`, `liveConnectConstraints`; client passes `access_token` or `Authorization: Token`).

Not confirmed (verify where stated; implementers record results in section 10):
- U1: whether Route Handlers impose a request body size limit in 16.2.12 (assumed none; the upload route enforces 50 MB itself).
- U2: `instrumentation.ts` location with a `src/` directory (assumed `src/instrumentation.ts`).
- U3: `searchParams` being a Promise in pages (assumed yes).
- U4: whether `serverActions.allowedOrigins` is read at `next start` time or baked at build (assumed build time; `install.sh` always rebuilds).
- U5: whether Tailscale Serve preserves `Host` and adds `X-Forwarded-For` (docs silent). The local-only guard relies on `Tailscale-User-Login`, which is confirmed.
- U6: `tailscale status --json` fields `BackendState`, `Self.DNSName`, and the `serve status --json` structure (format may change).
- U7: Homebrew CLI path `/opt/homebrew/bin/tailscale`.
- U8: whether `tailscale serve --yes` gets past the first-run HTTPS consent.
- U9: `pdf-parse` v2 per-page result shape.
- U10: AI SDK v7 file part property names for PDF input and Gemini's inline request size (assumed ≤ 20 MB).
- U11: Prisma Migrate behavior with FTS5 virtual tables (reason for rejecting FTS5).
- U12: `migration_lock.toml` exact format for Prisma 7.
- U13: whether the Prisma better-sqlite3 adapter enables `PRAGMA foreign_keys` (decides whether today's `deleteStudyPlan` throws or silently orphans logs). T08 deletes explicitly so the fix works either way.
- U14: whether a `'use server'` module may export `const x = wrapper(async …)` in Next 16. T04 avoids it by calling `requireAuth()` explicitly in each action.
- U15: raw WebSocket path for token-authenticated Live sessions and support for `gemini-3.1-flash-live-preview` with tokens (T05 step 1; fallback documented).
- U16: whether the Live API accepts a setup message with `systemInstruction` when the token has no `liveConnectConstraints` (assumed yes).

Corrections to the code review items (verified 2026-11-10):
- Survey filter: it excludes 132 exercises, not "about 130".
- Duplicate logs: 2 pairs but 3 surplus rows (one pair has three rows); the cleanup keeps the earliest attempt.
- `getStudyPlans` payload: correct in principle, but there are 0 plans, so it costs nothing today; it is trimmed anyway.
- `deleteStudyPlan`: the RESTRICT foreign key is real; whether it actually fails depends on U13.
- All other items were confirmed as stated.

Risks:
- R1 (data): the T02 migration redefines six tables and deletes 3 duplicate logs. Mitigated by backup, drift check, SQL review, exported deleted rows, counts and integrity checks, rollback by file copy.
- R2 (cost): an 800k-char upload costs ~15 segmentation calls + up to 60 starter calls, and each generated question now costs a second blind-solve call (T14). Limits in 4.1 bound it.
- R3 (dev + prod on one DB): the lease prevents double processing; SQLite write contention can cause `SQLITE_BUSY`. Stop the service while developing on the same DB.
- R4 (security): addressed by T04 (auth in every action, enforced by a test) and production bound to 127.0.0.1. Remaining exposure: anyone with the passcode cookie; the cookie stores the passcode itself (decision 2, unchanged).
- R5: the Gemini key reaches the browser until T05; if T05 finds tokens unsupported, the exception is documented and remains.
- R6: the auth cookie is `secure` in production. Safari may refuse `Secure` cookies on `http://localhost`; on the Mac use Chrome or the `https://…ts.net` URL.
- R7: a new space has no starter questions until the persona is accepted (by design, item 13); sessions started before that generate questions on the fly with `defaultProfile`.
- R8: `pickQuestionType` reproduces legacy cycles through `questionTypeCycles`.
- R9: `Topic.order` backfill depends on `className` matching outline link text.
- R10: Tailscale Serve on 443 is shared by everything on this Mac's tailnet name; enabling/disabling only touches `--https=443`.
- R11: changing grading (T12) changes how some past answers would be scored; past `isCorrect` values are not rewritten, only new logs use the new rules (differences reported in T12).
- R12: the `isGraded` backfill is rule-based and reviewed once; misclassified items can be fixed later only by SQL (no UI in this plan).
- R13: the unique log constraint means a re-answer in the same session is not recorded (first attempt wins). This matches the UI (cards cannot be re-answered) but drops the re-attempt pattern seen in one legacy session.

Assumptions:
- A1: uploaded PDFs usually have a text layer.
- A2: the owner accepts LLM module grouping with manual correction.
- A3: the legacy course titles in 3.3 are acceptable.

---

## 9. Owner manual steps

1. Before T02 and before the T03 backfill, make sure no `next dev`/`next start` runs against `web/dev.db`.
2. During T03, skim `backups/isGraded-review.tsv` if the implementer asks; it lists the exercises that will stop appearing in sessions.
3. Delete `NEXT_PUBLIC_GEMINI_API_KEY` from `web/.env` (nothing uses it).
4. Install Tailscale on the Mac (App Store or standalone package) and sign in; install it on the phone with the same account. For the standalone app, enable the CLI integration in its settings.
5. In the Tailscale admin console enable MagicDNS and HTTPS certificates (or approve them when step 6 prompts). Put `PHONE_ACCESS_HOST=<mac-name>.<tailnet>.ts.net` in `web/.env`.
6. Run `scripts/launchd/install.sh` once (builds and starts the service on 127.0.0.1:3000). Then run `tailscale serve --bg --https=443 localhost:3000` once in Terminal to finish any HTTPS consent; afterwards the toggle manages it.
7. On the phone open the `https://…ts.net` URL (or scan the QR on `/spaces`), log in, add to home screen, run a short session and the voice tutor; confirm the toggle is disabled on the phone. Then tell the implementer to run T30.
8. To stop the service: `scripts/launchd/uninstall.sh`.

---

## Backlog (not in this plan)

- Spaced-repetition scheduling (per-exercise due dates) replacing the lifetime-accuracy weak/unstudied/expert buckets in `createStudySession`.
- A text "Explain" button on wrong answers using the existing, currently unused `explainMistake` action.
- Voice tutor reconnection (session resumption every ~10 min with ephemeral tokens) and audio fixes.
- Analytics keyed by topic id instead of topic title / week strings.
- Plan sessions (`saveAndDeployStudyPlan`) always take the same first N exercises of their topics; use the normal selection instead.
- Found in browser testing (2026-11-10): `StudyInterface` mounts `ConfigureSessionDialog` in three places that share one `isModalOpen` state, so two dialogs render stacked when it opens (clicks reach the top one). Fix when T19/T20 restructure the study UI.
- Found in browser testing (2026-11-10): the history list shows an exam as "Score: 0/5" while its diagnosis says "0.33/5 (7%)" (whole-question versus partial-credit scoring). T12 must make both read the same stored `score`.
- Found in browser testing (2026-11-10): navigating back to an earlier question re-sends that question's full context to the tutor. Acceptable for now; a short "back on question N" notice would be cheaper.
- Found in browser testing (2026-11-11): after an exam is submitted and its diagnosis closed, the exam view stays on screen with a frozen timer and the Submit button until a reload or New Session. Fix with T17 (server-owned session state).
- Found in browser testing (2026-11-11): a tutor reply rendered with a stray fragment glued to its start ("How doI cannot confirm…"), likely a partial output transcription from the Live API. Look at it with the voice robustness item above.
- Found in browser testing (2026-11-11): the tutor mode selector (and the message box) is rendered twice in the DOM (mobile and desktop copies). Remove the duplicate when T20 moves the tutor into a bottom sheet.
- Found in browser testing (2026-11-11), REQUIRED in T17: after a page reload or resuming a past session, background generation does not know the session's topics (`activeSessionTopics` is empty) and falls back to every topic in the database, so a resumed session can generate questions from any week of any course. T17 stores `topicIds` on the session; its verification must include: reload mid-session and resume from History, then confirm newly generated exercises belong to the session's topics.
- Found in browser testing (2026-11-11), for T20: tutor replies come from audio transcription, so a markdown link is often written as a bracketed title plus a bare `/api/files/topic/<id>` path on its own line and is not clickable. When rendering chat text, turn bare `/api/files/topic/<id>` (with optional `#page=` / `?highlight=`) into a link handled by the viewer.
- Found in browser testing (2026-11-11): a diagnosis says "review the lecture slides on page N" but links to the question's own topic, because diagnosis inputs only list the topics of the answered exercises. Give the diagnosis prompts the sibling slide/transcript topics (same course, week, className) with their ids, so remedial links point at teaching material. Candidate for T15/T16.
- Found in browser testing (2026-11-11), for T20: the study card gives no partial-credit feedback. After a partially correct multi-select it only highlights the correct options; show "Partially correct" with the score, which the server now returns from `logAnswer`.
- Found in browser testing (2026-11-11), for T19/T20: "Practice This Week" and the start buttons are not disabled while a session is being created, so a second click creates a second session and leaves an empty active one in History. Disable them while loading, and do not list sessions with no answers as history entries.
- Found in browser testing (2026-11-11): the Session Results dialog lists questions in a different order from the one they were studied in. Use `SessionExercise.position` once T17 lands.
- From T15 measurements (2026-11-11): about a fifth of the not-yet-enriched imported questions cannot be answered standalone (they refer to a table, an earlier part, or "this program"), and rewriting does not fix them reliably. Instead of rewriting, mark such questions (needs a small schema addition, e.g. `Exercise.needsContext`) from the blind-solve triage and show a "View lecture context" link on the card that opens the question's preceding lecture topics in the viewer.
- From T15 measurements (2026-11-11): `blindSolve` handles legacy multi-blank shapes poorly (matching questions stored as `multiple_choice` with `[Dropdown n]` choices: it returns one blank only). Fix `solutionToUserAnswer` for multi-blank items before using blind solve on imported questions again. Generation only produces single-blank dropdowns, so generation is unaffected.
- Possible wrong answer keys in imported data found by the blind solve (2026-11-11), for the owner to review: exercise `626a0f67…` (14.750x, "statistically significant at the 5% level": the stored key reads as the probability that beta equals zero), and two matching questions whose key contains "Select an option" (`6d85c310…`, `66a0a6de…`, `b65a1e97…`, `1286986d…` are the candidates).
- Found in browser testing (2026-11-11): a generated question contained an odd label in its stem ("Focus Generation 1"). Check the generation prompt and grounding text for a label the model could be echoing.
- INCIDENT (2026-11-11): during T22 a test imported `@/lib/db` before setting `DATABASE_URL` and wrote 13 test courses (`c1`..`c13`) with 13 sources, 17 topics, 16 exercises, 2 sessions and 2 logs into the real `web/dev.db`. The owner's rows are intact (2 courses, 1,322 topics, 1,172 exercises, 31 sessions, 734 logs). Vitest now always runs against a temp database and storage directory (`vitest.config.ts`, `src/lib/testEnvGuard.test.ts`). Cleanup of the stray rows awaits the owner's approval: back up, then delete those 13 courses with their dependents and confirm the counts above. Until then, browser tests that copy `dev.db` must delete those rows from the COPY first.
- Data fix awaiting the owner (2026-11-11): the two `Slides PDF Error` topics ("Income around the world", "Part 1: Reading Section") have no PDF at all: the crawler never downloaded the slides and the old seed concatenated every file in the course root folder into their `content` (about 41 MB each). They cannot be re-extracted. Set their `content` to null (with a backup) and keep the `resourceType`; this frees about 80 MB. 49 of the 132 `.pdf` files under `MIT_Learn_Courses` are not PDFs (saved web pages, spreadsheets), which accounts for most topics with empty content.
- Cost note from T21 (2026-11-11): the Gemini fallback re-sends the whole PDF for each 15-page range (a 63-page sparse deck cost 5 calls and about 171k input tokens). Sending per-range PDFs would need a PDF-writing dependency; reconsider if scanned uploads become common.
- Data fix awaiting the owner (2026-11-11): 10 imported exercises have a `correctAnswer` made only of placeholder text ("[Dropdown n] Select an option"); they can no longer be answered correctly since placeholders stopped counting as answers. Mark them `status = 'reported'` (reason `broken_key`) with a backup, or repair their keys.
- Data fix awaiting the owner (2026-11-11): stored module names (`Topic.week`) from the original crawl are cut at 38 characters ("Week_01_Week_1__Introduction_to_Politi"); planner suggestions and module lists show the cut-off text. Restore full names from the course outline files.
- Found in browser testing (2026-11-11): on a phone the tab strip keeps its horizontal scroll position, so the active tab can sit partly off screen ("udy"). Scroll the active tab into view when it changes.
- Found in browser testing (2026-11-11): at 375x812 the Study Plan tab needs a 49 px scroll to reach its main action because of the reserved tutor band; tighten that panel's vertical spacing on phones.
- Found in browser testing (2026-11-11): the voice call ended once with no action from the student; no code path was found that ends it unintentionally, so a server-side or browser close is the likely cause. The panel now says the call ended. Reconnection belongs with the voice robustness item.
- Found in browser testing (2026-11-11): the first tutor connection in a dev session took about 18 s before any frame was sent (probably on-demand compilation plus token mint and context prefetch). Measure against the production build in T29 before treating it as a problem.
- Found in T23 testing (2026-11-11): in a new studyspace with no starter questions, the first question of a 100% AI-generated session appeared about 1 min 40 s after the session started (one blind-solve mismatch, one Gemini response blocked with `blockReason: OTHER`, which surfaces as "Invalid JSON response" and is retried). The starter questions of T25 cover the normal case; a blocked response could be recognised and reported as such instead of as invalid JSON.
- Found in T23 testing (2026-11-11): segmentation key terms are sometimes generic or inconsistently cased ("limiting", "Quantum yield").

---

## 10. Implementation notes (appended by implementers)

### Baseline (T01)
Recorded 2026-11-10, commit `7b2b2e4`, backup `backups/dev-T01-20261110-224100.db` (counts `2|1322|1172|31|737`, integrity ok).
- `npm run lint`: exit 1, 224 problems (174 errors, 50 warnings), all pre-existing; mostly `@typescript-eslint/no-explicit-any`, one `prefer-const` in `src/services/exerciseSelection.ts:17`, unused-variable warnings. Later tasks must add no new lint problems in the files they touch; a clean lint run is not expected.
- `npm run typecheck`: exit 0.
- `npx vitest run`: 7 files, 31 tests, all passing.
- `npm run build`: succeeds. Routes: `/`, `/_not-found`, `/api/file`, `/icon.png`, `/study`.
- `zod` declared as `^4.4.3` (the version already resolved).
- The T01 browser regression check was not run (no application code changed).

### Confirmations (T01)
From the installed packages (Next 16.2.12 docs in `node_modules/next/dist/docs/`), 2026-11-10:
- U1 Route Handler body size limit: not confirmed. `route.md` states no limit; the documented limits are for Server Actions (1 MB default, `serverActions.bodySizeLimit`) and the proxy (`proxyClientMaxBodySize`, 10 MB). Test with a large upload in T23.
- U2 `instrumentation.ts` location: confirmed, inside `src/` when the project uses it (`01-app/02-guides/instrumentation.md`).
- U3 `searchParams` is a Promise in pages: confirmed.
- `params` is a Promise in pages: confirmed. In route handlers: not looked up; check in the first task that adds a dynamic route handler (T10).
- `after` from `next/server`: confirmed.
- `serverActions.allowedOrigins`: confirmed as the config key.
- `next start` default hostname: the CLI reference says `0.0.0.0`; keep `-H 127.0.0.1`.
- U9 `pdf-parse` v2: confirmed. `getText()` returns `{ pages: { num, text }[], text }` (`dist/pdf-parse/esm/TextResult.d.ts`).
- U10 AI SDK file part: confirmed field names `type: 'file'`, `data`, `mediaType`, optional `filename` (`@ai-sdk/provider-utils` `FilePart`). Gemini inline size limit still unconfirmed.
- R5: nothing in `src` references `NEXT_PUBLIC_GEMINI_API_KEY`.
- U4–U8, U11–U16: not checked in T01; each is checked in the task that depends on it.
