-- Remove duplicate (sessionId, exerciseId) logs, keeping the earliest attempt,
-- so the unique index below can be created. Must run before ExerciseLog is redefined.
DELETE FROM "ExerciseLog" WHERE "id" IN (
  SELECT l."id" FROM "ExerciseLog" l
  WHERE EXISTS (
    SELECT 1 FROM "ExerciseLog" e
    WHERE e."sessionId" = l."sessionId" AND e."exerciseId" = l."exerciseId"
      AND (e."timestamp" < l."timestamp" OR (e."timestamp" = l."timestamp" AND e."id" < l."id"))
  )
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "bundle" TEXT NOT NULL DEFAULT 'initial',
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "failedStage" TEXT,
    "error" TEXT,
    "warning" TEXT,
    "pageCount" INTEGER,
    "charCount" INTEGER,
    "usedOcrFallback" BOOLEAN NOT NULL DEFAULT false,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Source_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionExercise" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "draftAnswer" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "timeSpentSec" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SessionExercise_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionExercise_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "profile" TEXT,
    "profileSuggestion" TEXT,
    "goal" TEXT,
    "starterStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Course" ("code", "description", "id", "title") SELECT "code", "description", "id", "title" FROM "Course";
DROP TABLE "Course";
ALTER TABLE "new_Course" RENAME TO "Course";
CREATE UNIQUE INDEX "Course_code_key" ON "Course"("code");
CREATE TABLE "new_Exercise" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "exerciseType" TEXT NOT NULL DEFAULT 'single_choice',
    "choices" TEXT NOT NULL,
    "correctAnswer" TEXT NOT NULL,
    "explanation" TEXT,
    "isGraded" BOOLEAN NOT NULL DEFAULT true,
    "origin" TEXT NOT NULL DEFAULT 'imported',
    "status" TEXT NOT NULL DEFAULT 'active',
    "promptVersion" TEXT,
    "originalQuestionText" TEXT,
    "enrichedAt" DATETIME,
    "reportedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Exercise_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Exercise" ("choices", "correctAnswer", "exerciseType", "explanation", "id", "questionText", "topicId") SELECT "choices", "correctAnswer", "exerciseType", "explanation", "id", "questionText", "topicId" FROM "Exercise";
DROP TABLE "Exercise";
ALTER TABLE "new_Exercise" RENAME TO "Exercise";
CREATE INDEX "Exercise_topicId_idx" ON "Exercise"("topicId");
CREATE TABLE "new_ExerciseLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "score" REAL,
    "assisted" BOOLEAN NOT NULL DEFAULT false,
    "userAnswer" TEXT,
    "duration" INTEGER NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExerciseLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExerciseLog_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ExerciseLog" ("duration", "exerciseId", "id", "isCorrect", "sessionId", "timestamp", "userAnswer") SELECT "duration", "exerciseId", "id", "isCorrect", "sessionId", "timestamp", "userAnswer" FROM "ExerciseLog";
DROP TABLE "ExerciseLog";
ALTER TABLE "new_ExerciseLog" RENAME TO "ExerciseLog";
CREATE INDEX "ExerciseLog_exerciseId_idx" ON "ExerciseLog"("exerciseId");
CREATE UNIQUE INDEX "ExerciseLog_sessionId_exerciseId_key" ON "ExerciseLog"("sessionId", "exerciseId");
CREATE TABLE "new_StudyPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "executiveSummary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StudyPlan_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_StudyPlan" ("createdAt", "executiveSummary", "id", "status", "title", "updatedAt") SELECT "createdAt", "executiveSummary", "id", "status", "title", "updatedAt" FROM "StudyPlan";
DROP TABLE "StudyPlan";
ALTER TABLE "new_StudyPlan" RENAME TO "StudyPlan";
CREATE TABLE "new_StudySession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "title" TEXT,
    "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" DATETIME,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'study',
    "timeLimit" INTEGER,
    "draftAnswers" TEXT,
    "flaggedIds" TEXT,
    "sourcingMix" INTEGER NOT NULL DEFAULT 50,
    "diagnosis" TEXT,
    "chatLog" TEXT,
    "exerciseIds" TEXT,
    "studyPlanId" TEXT,
    "topicIds" TEXT,
    "targetCount" INTEGER,
    "deadline" DATETIME,
    "currentPosition" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "StudySession_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StudySession_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_StudySession" ("chatLog", "diagnosis", "draftAnswers", "endTime", "exerciseIds", "flaggedIds", "id", "mode", "sourcingMix", "startTime", "status", "studyPlanId", "timeLimit", "title") SELECT "chatLog", "diagnosis", "draftAnswers", "endTime", "exerciseIds", "flaggedIds", "id", "mode", "sourcingMix", "startTime", "status", "studyPlanId", "timeLimit", "title" FROM "StudySession";
DROP TABLE "StudySession";
ALTER TABLE "new_StudySession" RENAME TO "StudySession";
CREATE INDEX "StudySession_courseId_startTime_idx" ON "StudySession"("courseId", "startTime");
CREATE TABLE "new_Topic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "sourceId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "week" TEXT,
    "className" TEXT,
    "unit" TEXT,
    "title" TEXT NOT NULL,
    "resourceType" TEXT,
    "content" TEXT,
    "localPath" TEXT,
    "summary" TEXT,
    "keyTerms" TEXT,
    "isQuantitative" BOOLEAN NOT NULL DEFAULT false,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    CONSTRAINT "Topic_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Topic_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Topic" ("className", "content", "courseId", "id", "localPath", "resourceType", "title", "unit", "week") SELECT "className", "content", "courseId", "id", "localPath", "resourceType", "title", "unit", "week" FROM "Topic";
DROP TABLE "Topic";
ALTER TABLE "new_Topic" RENAME TO "Topic";
CREATE INDEX "Topic_courseId_order_idx" ON "Topic"("courseId", "order");
CREATE INDEX "Topic_courseId_week_idx" ON "Topic"("courseId", "week");
CREATE INDEX "Topic_sourceId_idx" ON "Topic"("sourceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Source_courseId_idx" ON "Source"("courseId");

-- CreateIndex
CREATE INDEX "SessionExercise_exerciseId_idx" ON "SessionExercise"("exerciseId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionExercise_sessionId_exerciseId_key" ON "SessionExercise"("sessionId", "exerciseId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionExercise_sessionId_position_key" ON "SessionExercise"("sessionId", "position");

