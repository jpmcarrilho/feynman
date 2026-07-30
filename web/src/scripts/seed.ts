import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import Database from 'better-sqlite3'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { parseLessonContent } from '../services/ingest'

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || 'file:./dev.db' })
const prisma = new PrismaClient({ adapter })

const BASE_DIR = path.join(__dirname, '../../../MIT_Learn_Courses')

async function main() {
  console.log('Starting seed process...')
  const courses = ['JPAL102x', '14.750x']

  for (const courseCode of courses) {
    let course = await prisma.course.findUnique({ where: { code: courseCode } })
    if (!course) {
      course = await prisma.course.create({
        data: { code: courseCode, title: courseCode }
      })
    }
    console.log(`Processing course: ${course.code}`)

    const outlinePath = path.join(BASE_DIR, `${courseCode}_outline.json`)
    if (!fs.existsSync(outlinePath)) {
      console.log(`Outline not found: ${outlinePath}`)
      continue
    }

    const outline = JSON.parse(fs.readFileSync(outlinePath, 'utf8'))

    for (let s = 0; s < outline.length; s++) {
      const section = outline[s]
      const weekFolder = `Week_${String(s + 1).padStart(2, '0')}_${section.sectionTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`
      const targetDir = path.join(BASE_DIR, courseCode, weekFolder)
      
      for (const link of section.links) {
        const safeName = link.text.replace(/[^a-zA-Z0-9]/g, '_')
        const txtFilePath = path.join(targetDir, `${safeName}.txt`)
        
        if (!fs.existsSync(txtFilePath)) continue;
        
        const content = fs.readFileSync(txtFilePath, 'utf8')
        const parsed = parseLessonContent(content)
        
        let topicType = 'lecture'
        if (link.text.toLowerCase().includes('quiz') || link.text.toLowerCase().includes('problem') || link.text.toLowerCase().includes('exam')) {
          topicType = 'quiz'
        }

        const topic = await prisma.topic.create({
          data: {
            courseId: course.id,
            week: s + 1,
            title: link.text,
            type: topicType
          }
        })

        let exCount = 0;
        for (const ex of parsed.exercises) {
          if (!ex.correctAnswer || ex.choices.length === 0) continue;
          await prisma.exercise.create({
            data: {
              topicId: topic.id,
              questionText: ex.questionText,
              choices: JSON.stringify(ex.choices),
              correctAnswer: ex.correctAnswer,
              explanation: ex.explanation || null
            }
          })
          exCount++;
        }
        if (exCount > 0) {
          console.log(`  - Inserted ${exCount} exercises for ${link.text}`)
        }
      }
    }
  }
  console.log('Seed process completed successfully!')
}

main().catch(console.error).finally(() => prisma.$disconnect())
