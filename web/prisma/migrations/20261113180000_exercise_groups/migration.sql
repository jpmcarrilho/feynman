-- CreateTable
CREATE TABLE "ExerciseGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'imported',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExerciseGroup_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN "groupId" TEXT REFERENCES "ExerciseGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Exercise" ADD COLUMN "groupPosition" INTEGER;

-- CreateIndex
CREATE INDEX "ExerciseGroup_topicId_idx" ON "ExerciseGroup"("topicId");
CREATE INDEX "Exercise_groupId_idx" ON "Exercise"("groupId");
