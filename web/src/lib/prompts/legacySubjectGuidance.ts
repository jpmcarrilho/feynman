// Subject-specific prompt fragments for the two pre-studyspace MIT courses (14.750x, JPAL102x).
// Written verbatim from the prompts that were hard-coded in actions.ts before the prompts module existed.
// Any other space gets the generic fragments below (no named papers, no economics methodology).

export interface SubjectGuidance {
  // generateExercisePrompt fragments
  principles: string
  scenarioExample: string
  calcExamples: string
  angleExample: string
  termWord: string
  namedStudies: string
  triviaPrinciples: string
  synthesisBlock: string
  formatRules: string[]
  // enrichExercisePrompt fragments
  enrichIntroExamples: string
  enrichConceptualExamples: string
  enrichCaseExamples: string
  // diagnosis fragments
  misinterpretation: string
  trapExamples: string
  intuition: string
  patternExamples: string
  gapExamples: string
}

export const LEGACY_COURSE_CODES = ['14.750x', 'JPAL102x']

const NO_PLACEHOLDERS = `NO PLACEHOLDERS: Do not use spinner or loading image placeholders. All images, tables, and references must be fully specified or represented in text/markdown.`

const LEGACY_GUIDANCE: SubjectGuidance = {
  principles: 'economic, statistical, or data collection principles',
  scenarioExample: ` If an existing question uses Olken's corruption study in Indonesia, your new question should describe a parallel hypothetical or actual evaluation in another context (e.g., an educational audit in India or construction in Kenya) to test the same underlying statistical principles.`,
  calcExamples: 'Wald estimates, standard errors, coefficients, utility functions, or regression equations',
  angleExample: ` For example, if the existing question tests the "exclusion restriction" of an IV, your new question can test the "reduced form", "first stage strength", or discuss why "parallel trends" or "omitted variable bias" would fail in a similar model. If an existing question is from a citizen-candidate perspective, look at it from the voter's perspective, or modify the cost of entry parameter.`,
  termWord: 'economic terms',
  namedStudies: ' (such as Acemoglu et al. 2001, Dell 2010, Olken 2007, Ferraz & Finan 2008, the Balsakhi program, or the Mita system)',
  triviaPrinciples: 'economic, statistical, or logical principles',
  synthesisBlock: `COMPREHENSIVE REVIEW SYNTHESIS METHODOLOGY (HOW TO EXTRACT FROM CONTENT):
You must extract high-signal concepts from the provided Target Topic content and synthesize them into questions that mirror the style, depth, and layout of MIT MicroMasters Comprehensive Review exams:
1. EMPIRICAL/ECONOMETRIC SYNTHESIS: 
   - Identify the regression equation or causal identification strategy mentioned in the text (e.g. Difference-in-Differences, Instrumental Variables, or Regression Discontinuity).
   - Write a self-contained question that explicitly presents the regression equation (using clean LaTeX formatting, e.g., \\( Y_{ic} = \\alpha + \\beta \\text{Treatment}_c + \\gamma X_i + \\epsilon_{ic} \\)), defines what each variable represents, and asks about the interpretation, bias, or sign of the coefficients (\\(\\beta\\)).
2. THEORETICAL/MICROECONOMIC SYNTHESIS:
   - Identify the economic actor's decisions, payoffs, costs of effort, or utility functions described in the text (e.g., citizen-candidate entry costs, politician rent-seeking, or taxpayer bribe negotiation).
   - Present the math clearly (e.g., utility \\( U_i = p(e) \\cdot B - C(e) \\)), explain each parameter, and ask questions requiring the student to identify the correct objective function, utility constraint, or the sign/implication of a derivative (e.g., \\(\\dfrac{db}{dr}\\)).
3. RESEARCH METHODOLOGY & LOGISTICS SYNTHESIS:
   - Identify the survey design, field pilot, quality control, or IRB ethical principles discussed in the text (e.g., attrition bias, Minimum Detectable Effect standard deviations, dual-entry discrepancies, spot checks, or behavioral trust games).
   - Present a concrete, self-contained operational scenario (e.g., "A research team is administering surveys in-house...") and ask the student to identify the specific operational issue (e.g., differential coverage bias, social desirability, or telescoping), calculate the MDE, or explain the logical survey skip patterns.`,
  formatRules: [
    `EMPIRICAL DATA TABLES: When generating questions for empirical or measurement weeks, you are strongly encouraged to construct a realistic, clean Markdown data table representing survey audit discrepancies, sample allocation matrices, standard deviation blocks, or regression output coefficients. The question must then require the student to analyze, calculate, or interpret values directly from this Markdown table.`,
    NO_PLACEHOLDERS,
  ],
  enrichIntroExamples: ' (e.g., the Balsakhi program, the GoBifo study, the Extra Teacher Program)',
  enrichConceptualExamples: ' (e.g., "In a cluster randomized evaluation, doubling the sample size will...", "What is statistical power?", or general math/statistics/economics questions)',
  enrichCaseExamples: ' (e.g., "Balsakhi program", "GoBifo")',
  misinterpretation: ' or economic misinterpretation',
  trapExamples: ' (e.g., confusing OLS correlation with causality, failing to solve the first-order conditions, or forgetting how selection bias affects simple difference measures)',
  intuition: 'economic intuition',
  patternExamples: ' (e.g. "strong on theoretical RCT layouts, but struggling on mathematical modeling, statistical sampling power, or empirical identification strategies")',
  gapExamples: ` (e.g., explaining why adding more individual observations to clustered samples does not solve power issues if the Intra-cluster Correlation is high, or explaining Olken's media study designs in Indonesia, or Ferraz & Finan's re-election incentive model)`,
}

const GENERIC_BASE: Omit<SubjectGuidance, 'synthesisBlock' | 'formatRules'> = {
  principles: 'principles',
  scenarioExample: '',
  calcExamples: 'formulas, coefficients, parameters, or equations',
  angleExample: '',
  termWord: 'domain-specific terms',
  namedStudies: '',
  triviaPrinciples: 'and logical principles',
  enrichIntroExamples: '',
  enrichConceptualExamples: '',
  enrichCaseExamples: '',
  misinterpretation: ' or misconception',
  trapExamples: '',
  intuition: 'intuition',
  patternExamples: '',
  gapExamples: '',
}

const GENERIC_QUANTITATIVE_BLOCK = `QUANTITATIVE QUESTION GUIDANCE:
This topic requires calculation. Write a self-contained question with worked numbers: state every given value, write equations in clean LaTeX (e.g., \\( y = mx + b \\)), define each variable, and require the student to compute or interpret a result. You may include a clean Markdown table of data when the topic calls for it.`

const GENERIC_QUALITATIVE_BLOCK = `QUESTION STYLE GUIDANCE:
Prefer scenario-based questions: describe a concrete, self-contained situation drawn from the Target Topic content and ask the student to apply the concept to it, rather than to recall a definition.`

/** Fragments for the given course code(s): legacy text when any code is a legacy MIT course, generic otherwise. */
export function subjectGuidance(courseCode?: string | string[] | null, isQuantitative = false): SubjectGuidance {
  const codes = Array.isArray(courseCode) ? courseCode : courseCode ? [courseCode] : []
  if (codes.some((c) => LEGACY_COURSE_CODES.includes(c))) return LEGACY_GUIDANCE
  return {
    ...GENERIC_BASE,
    synthesisBlock: isQuantitative ? GENERIC_QUANTITATIVE_BLOCK : GENERIC_QUALITATIVE_BLOCK,
    formatRules: [NO_PLACEHOLDERS],
  }
}
