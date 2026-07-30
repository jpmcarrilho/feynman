const fs = require('fs');
let code = fs.readFileSync('MIT_Learn_Courses/run_crawler.js', 'utf8');

const oldAppend = 'function appendToCSV(course, week, topic, resourceName, resourceType, localPath, url) {\n  const row = `"${course}","${week}","${topic}","${resourceName}","${resourceType}","${localPath}","${url}"\\n`;\n  fs.appendFileSync(REGISTRY_FILE, row);\n}';
const newAppend = 'function appendToCSV(course, week, topic, unitIndex, unitTitle, resourceType, localPath, url) {\n  const row = `"${course}","${week}","${topic}","${unitIndex}","${unitTitle}","${resourceType}","${localPath}","${url}"\\n`;\n  fs.appendFileSync(REGISTRY_FILE, row);\n}';

code = code.replace(oldAppend, newAppend);

code = code.replace(/appendToCSV\('\$1', weekFolder, link\.text \+ ' - ' \+ unitTitle, `\$\{link\.text\} Exercise Questions`, 'Exercise Content & Solutions', sectionDir, link\.href\);/g,
  "appendToCSV('$1', weekFolder, link.text, unitIndex, unitTitle, 'Exercise Content & Solutions', sectionDir, link.href);");

code = code.replace(/appendToCSV\('\$1', weekFolder, link\.text \+ ' - ' \+ unitTitle, `\$\{unitTitle\} Slides`, 'Slides PDF', pdfLocalPath, link\.href\);/g,
  "appendToCSV('$1', weekFolder, link.text, unitIndex, unitTitle, 'Slides PDF', pdfLocalPath, link.href);");

code = code.replace(/appendToCSV\('\$1', weekFolder, link\.text \+ ' - ' \+ unitTitle, `\$\{unitTitle\} Transcript`, 'Transcript \.txt', transcriptUrl, link\.href\);/g,
  "appendToCSV('$1', weekFolder, link.text, unitIndex, unitTitle, 'Transcript .md', path.join(sectionDir, 'Transcript.md'), link.href);");

// Initialize CSV with new headers if missing or overwrite
code = code.replace(/\/\/ Ensure base directories exist\nif \(!fs\.existsSync\(BASE_DIR\)\) fs\.mkdirSync\(BASE_DIR\);/g,
`// Ensure base directories exist
if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR);

// Initialize CSV with headers
if (!fs.existsSync(REGISTRY_FILE) || process.argv.includes('--force')) {
  fs.writeFileSync(REGISTRY_FILE, '"Course","Week","Class / Sequential","Unit Number","Unit Title","Resource Type","Local Path","URL"\\n');
}`);

fs.writeFileSync('MIT_Learn_Courses/run_crawler.js', code);
console.log('CSV registry format updated with dedicated columns for Unit Index and Unit Title.');