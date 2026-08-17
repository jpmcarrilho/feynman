const Database = require("better-sqlite3");
const db = new Database("dev.db");

// Query to get all exercises and their logs per week for JPAL102x
const query = `
  SELECT 
    t.week,
    COUNT(DISTINCT e.id) as totalExercises,
    COUNT(DISTINCT l.id) as answeredCount,
    SUM(CASE WHEN l.isCorrect = 1 THEN 1 ELSE 0 END) as correctCount
  FROM Topic t
  JOIN Exercise e ON e.topicId = t.id
  LEFT JOIN ExerciseLog l ON l.exerciseId = e.id
  WHERE t.courseId = (SELECT id FROM Course WHERE code = 'JPAL102x' LIMIT 1)
  GROUP BY t.week
  ORDER BY t.week ASC;
`;

const rows = db.prepare(query).all();

console.log("=== JPAL102x HIGH-RESOLUTION PROGRESS REPORT ===");
console.log("----------------------------------------------------------------------------------");
console.log("Week                                | Total Qs | Answered | Correct | Raw Acc % | Confidence Level");
console.log("----------------------------------------------------------------------------------");

rows.forEach(r => {
  const total = r.totalExercises;
  const ans = r.answeredCount;
  const corr = r.correctCount || 0;
  
  // Calculate accuracy only if answered > 0
  const rawAcc = ans > 0 ? Math.round((corr / ans) * 100) : 0;
  const coverage = Math.round((ans / total) * 100);
  
  // Classify Confidence based on sample size (number of answered questions)
  let confidence = "High";
  if (ans === 0) confidence = "N/A (Unstudied)";
  else if (ans <= 2) confidence = "Low (Sample size too small!)";
  else if (ans <= 4) confidence = "Medium";
  
  const paddedWeek = r.week.padEnd(35, " ");
  const paddedTotal = String(total).padStart(8, " ");
  const paddedAns = String(ans).padStart(8, " ");
  const paddedCorr = String(corr).padStart(7, " ");
  const paddedAcc = ans > 0 ? `${rawAcc}%`.padStart(9, " ") : "N/A".padStart(9, " ");
  
  console.log(`${paddedWeek} | ${paddedTotal} | ${paddedAns} | ${paddedCorr} | ${paddedAcc} | ${confidence}`);
});
console.log("----------------------------------------------------------------------------------");
