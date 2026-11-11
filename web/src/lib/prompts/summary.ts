import type { TutorProfile } from '@/lib/studyspace/profile'
import { persona, FEYNMAN_METHOD, analogyList } from './persona'

export function moduleSummaryPrompt(
  profile: TutorProfile,
  input: { courseCode: string; courseTitle: string; module: string; material: string },
): string {
  return `${persona(profile)} ${FEYNMAN_METHOD}
Your task is to generate a comprehensive, highly detailed permanent study guide and week summary for the following course week:

Course: ${input.courseCode} - ${input.courseTitle}
Week: ${input.module}

CRITICAL DIRECTIVES:
1. Grounded in Lesson Content: This is a permanent, high-quality textbook study guide. You must use the actual Covered Material Context (the lecture transcripts, slides outlines, and textbook readings) to summarize and explain the core academic concepts. 
2. Be concise and simplified: Adhere to the Feynman Technique of making concepts incredibly simple and intuitive using elegant, grounded analogies (like ${analogyList(profile)}), but do not be overly verbose or repetitive.
3. No Question Leakage: Under no circumstances should you generate or refer to specific sample questions or tests. Focus 100% on the core lecture topics and learning objectives.

Covered Material Context (Extracted slides, transcripts, and reading content for this week):
${input.material || 'No raw lesson materials available.'}

Generate a beautifully styled Markdown document. Break it down into these exact sections:
1. # 📓 Course Study Guide: ${input.courseCode} | ${input.module}
   An elegant overview of this week's topics, general learning objectives, and core themes.
2. ## 🧠 Concepts Demystified (Feynman Style)
   Explain the main 2-3 core academic concepts covered in this week's materials. Explain each one in simple terms, using an elegant analogy to convey the underlying intuition.
3. ## 🔍 Common Pitfalls & Key Terms
   Identify common misconceptions, tricky details, or academic traps in these specific topics, and explain how to understand them correctly from first principles.
4. ## 📝 Custom Class Cheat Sheet
   A bulleted, extremely concise reference summarizing key equations, core definitions, or central principles from these specific lectures.
5. ## 🚀 Recommended Next Steps
   Suggested concrete review goals (e.g., specific slides, read-throughs, or topic units).

Ensure all equations are nicely formatted in standard LaTeX format when appropriate (wrap math blocks in $$ block $$ or $ inline $).`
}
