export interface ParsedExercise {
  questionText: string;
  choices: string[];
  correctAnswer: string;
  explanation?: string;
}

export interface ParsedLesson {
  url: string;
  slidesUrl: string;
  transcript: string;
  exercises: ParsedExercise[];
  contents: string[];
}

export function parseExerciseBlock(blockText: string): ParsedExercise {
  const lines = blockText.split('\n').map(l => l.trim());
  const choices: string[] = [];
  let correctAnswer = '';
  
  const questionLines: string[] = [];
  const explanationLines: string[] = [];
  
  let inExplanation = false;
  let inChoices = false;
  
  const junkPhrases = [
    'show answer', 'submit', 'you have used', 'grading method', 
    'some problems have options', 'correct', 'skip to main content',
    'point (graded)', 'choices:'
  ];
  
  for (const line of lines) {
    if (line === '') continue;

    if (line.toLowerCase().startsWith('explanation:') || line.toLowerCase().startsWith('solution:')) {
      inExplanation = true;
      explanationLines.push(line.replace(/^(explanation|solution):\s*/i, ''));
      continue;
    }
    
    if (inExplanation) {
      explanationLines.push(line);
      continue;
    }
    
    if (line.startsWith('- [ ]') || line.startsWith('- [x]')) {
      inChoices = true;
      const choiceText = line.substring(5).trim();
      choices.push(choiceText);
      if (line.startsWith('- [x]')) {
        correctAnswer = choiceText;
      }
      continue;
    }

    if (inChoices) {
      // Past the choices, ignore junk
      const lower = line.toLowerCase();
      if (junkPhrases.some(p => lower.includes(p))) continue;
      continue; 
    } else {
      // Still in question text
      const lower = line.toLowerCase();
      if (junkPhrases.some(p => lower === p || lower.startsWith(p))) continue;
      if (line.toLowerCase() === 'question:') continue;
      questionLines.push(line);
    }
  }
  
  // Post-process question lines to remove duplicated choices
  const cleanedQuestionLines = questionLines.filter(qLine => {
    // If this line is exactly one of the choices, skip it
    return !choices.some(c => c === qLine);
  });
  
  return {
    questionText: cleanedQuestionLines.join('\n').trim(),
    choices,
    correctAnswer,
    explanation: explanationLines.length > 0 ? explanationLines.join('\n').trim() : undefined
  };
}

export function parseLessonContent(content: string): ParsedLesson {
  const parsed: ParsedLesson = {
    url: '',
    slidesUrl: '',
    transcript: '',
    exercises: [],
    contents: []
  };
  
  const urlMatch = content.match(/URL:\s*(https:\/\/[^\n]+)/);
  if (urlMatch) parsed.url = urlMatch[1].trim();
  
  let currentBlockType: string | null = null;
  let currentBlockLines: string[] = [];
  
  const flushCurrentBlock = () => {
    if (!currentBlockType) return;
    const blockText = currentBlockLines.join('\n').trim();
    if (currentBlockType === 'transcript') {
      parsed.transcript = blockText;
    } else if (currentBlockType === 'exercise') {
      parsed.exercises.push(parseExerciseBlock(blockText));
    } else if (currentBlockType === 'content') {
      parsed.contents.push(blockText);
    }
    currentBlockType = null;
    currentBlockLines = [];
  };
  
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('[SLIDES PDF]')) {
      flushCurrentBlock();
      currentBlockType = 'slides';
    } else if (line.startsWith('[TRANSCRIPT]')) {
      flushCurrentBlock();
      currentBlockType = 'transcript';
    } else if (line.startsWith('[EXERCISE/PROBLEM]')) {
      flushCurrentBlock();
      currentBlockType = 'exercise';
    } else if (line.startsWith('[CONTENT]')) {
      flushCurrentBlock();
      currentBlockType = 'content';
    } else if (line.startsWith('==================') && currentBlockType) {
      flushCurrentBlock();
    } else if (currentBlockType) {
      if (currentBlockType === 'slides' && line.startsWith('Slide URL: ')) {
        parsed.slidesUrl = line.replace('Slide URL: ', '').trim();
        currentBlockType = null;
      } else {
        currentBlockLines.push(line);
      }
    }
  }
  
  flushCurrentBlock();
  
  return parsed;
}
