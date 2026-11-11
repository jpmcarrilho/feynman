-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN "keyPoints" TEXT;

-- AlterTable
ALTER TABLE "ExerciseLog" ADD COLUMN "feedback" TEXT;
ALTER TABLE "ExerciseLog" ADD COLUMN "gradedBy" TEXT;
