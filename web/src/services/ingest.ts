import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { PDFParse } from 'pdf-parse';

export interface CsvResourceRow {
  Course: string;
  Week: string;
  'Class / Sequential': string;
  'Unit Number': string;
  'Unit Title': string;
  'Resource Type': string;
  'Local Path': string;
}

export interface ParsedExercise {
  questionText: string;
  choices: string[];
  correctAnswer: string;
  explanation: string;
  exerciseType?: string;
}

/**
 * Reads the resources_registry.csv and returns typed records
 */
export function parseRegistryCsv(csvFilePath: string): CsvResourceRow[] {
  const fileContent = fs.readFileSync(csvFilePath, 'utf-8');
  const records = parse(fileContent, {
    columns: true, // Uses the first row as object keys
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
  return records as CsvResourceRow[];
}

/**
 * Extracts clean text from PDF using pdf-parse
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  try {
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    return data.text.trim();
  } catch (error: any) {
    console.warn(`  [Warning] Failed to parse PDF: ${error.message || 'Unknown error'}`);
    return "";
  }
}

/**
 * Parses markdown exercises into structured JSON 
 * (Question, Choices, Correct Answer, Explanation)
 */
export function parseExerciseMarkdown(rawText: string): ParsedExercise[] {
  const exercises: ParsedExercise[] = [];
  
  // Split the file by "# Question"
  const blocks = rawText.split(/^# Question/m).filter(b => b.trim().length > 0);

  for (const block of blocks) {
    // Filter out EdX junk phrases like "1/1 point (graded)"
    const cleanedBlock = block.replace(/\d+\/\d+\s+point\s+\(graded\)/gi, '').trim();

    // Find the boundaries of the sections
    const choicesMatch = cleanedBlock.match(/## Choices\n([\s\S]*?)(?=## Explanation\/Solution|$)/);
    const explanationMatch = cleanedBlock.match(/## Explanation\/Solution\n([\s\S]*)$/);
    
    // Extract Question Text
    let questionText = cleanedBlock;
    if (choicesMatch) {
      questionText = cleanedBlock.substring(0, choicesMatch.index).trim();
    } else if (explanationMatch) {
      questionText = cleanedBlock.substring(0, explanationMatch.index).trim();
    }

    // Extract Choices and Correct Answer
    const choicesRaw = choicesMatch ? choicesMatch[1].trim().split('\n') : [];
    const choices: string[] = [];
    const correctAnswersList: string[] = [];

    for (const choice of choicesRaw) {
      const trimmed = choice.trim();
      if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) {
        const answerText = trimmed.substring(5).trim();
        choices.push(answerText);
        correctAnswersList.push(answerText);
      } else if (trimmed.startsWith('- [ ]')) {
        choices.push(trimmed.substring(5).trim());
      } else if (trimmed.length > 0) {
         const cleaned = trimmed.replace(/^-/, '').trim();
         if (/^(correct|incorrect|unanswered|answered)$/i.test(cleaned)) continue;
         choices.push(cleaned); // Fallback for weird formatting
      }
    }

    // Extract Explanation
    const explanation = explanationMatch ? explanationMatch[1].trim() : '';

    let exerciseType = 'single_choice';
    let correctAnswer = '';
    
    if (correctAnswersList.length > 1) {
      exerciseType = 'multiple_choice';
      correctAnswer = JSON.stringify(correctAnswersList);
    } else if (correctAnswersList.length === 1) {
      correctAnswer = correctAnswersList[0];
    }

    exercises.push({
      questionText,
      choices,
      correctAnswer,
      explanation,
      exerciseType
    });
  }

  return exercises;
}
