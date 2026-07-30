const fs = require('fs');
const path = require('path');
let code = fs.readFileSync('MIT_Learn_Courses/run_crawler.js', 'utf8');

// 1. Extract Unit Title and create section directory
const oldIframeLogic = `
          let activeIframe = null;
          let retryCount = 0;
          
          while (retryCount < 3 && !activeIframe) {
            try {
              await page.waitForSelector('iframe', { timeout: 3000 }).catch(() => {});
              const iframes = await page.$$('iframe');
              
              for (const frame of iframes) {
                const title = await page.evaluate(el => el.title, frame).catch(() => null);
                if (title && title !== 'Sticky Launcher') {
                  activeIframe = frame;
                  break;
                }
              }
            } catch (err) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              retryCount++;
            }
          }
`;

const newIframeLogic = `
          let activeIframe = null;
          let retryCount = 0;
          let unitTitle = 'Unit_' + unitIndex;
          
          while (retryCount < 3 && !activeIframe) {
            try {
              await page.waitForSelector('iframe', { timeout: 3000 }).catch(() => {});
              const iframes = await page.$$('iframe');
              
              for (const frame of iframes) {
                const title = await page.evaluate(el => el.title, frame).catch(() => null);
                if (title && title !== 'Sticky Launcher') {
                  activeIframe = frame;
                  unitTitle = title;
                  break;
                }
              }
            } catch (err) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              retryCount++;
            }
          }
          
          const safeUnitTitle = String(unitIndex).padStart(2, '0') + '_' + unitTitle.replace(/[^a-zA-Z0-9]/g, '_');
          const sectionDir = path.join(lessonDir, safeUnitTitle);
          if (activeIframe && !fs.existsSync(sectionDir)) fs.mkdirSync(sectionDir, { recursive: true });
`;

if (code.includes(oldIframeLogic.trim())) {
  code = code.replace(oldIframeLogic.trim(), newIframeLogic.trim());
} else {
  console.log("Could not find oldIframeLogic");
}

// 2. Change lessonDir to sectionDir in file writing logic
// PDF:
code = code.replace(/fs\.writeFileSync\(path\.join\(lessonDir, 'Slides\.md'\)/g, "fs.writeFileSync(path.join(sectionDir, 'Slides.md')");
code = code.replace(/const pdfLocalPath = path\.join\(lessonDir, 'Slides\.pdf'\);/g, "const pdfLocalPath = path.join(sectionDir, 'Slides.pdf');");

// Transcript:
code = code.replace(/fs\.writeFileSync\(path\.join\(lessonDir, 'Transcript\.md'\)/g, "fs.writeFileSync(path.join(sectionDir, 'Transcript.md')");

// Exercises:
code = code.replace(/const probPath = path\.join\(lessonDir, `Exercise_\$\{probIndex\}\.md`\);/g, "const probPath = path.join(sectionDir, `Exercise_${probIndex}.md`);");

// Fix appendToCSV
code = code.replace(/appendToCSV\('\$1', weekFolder, link\.text, `\$\{link\.text\} Exercise Questions`, 'Exercise Content & Solutions', lessonDir, link\.href\);/g, 
"appendToCSV('$1', weekFolder, link.text + ' - ' + unitTitle, `${link.text} Exercise Questions`, 'Exercise Content & Solutions', sectionDir, link.href);");

code = code.replace(/appendToCSV\('([^']+)', weekFolder, link\.text, `\$\{link\.text\} Slides`, 'Slides PDF', pdfLocalPath, link\.href\);/g,
"appendToCSV('$1', weekFolder, link.text + ' - ' + unitTitle, `${unitTitle} Slides`, 'Slides PDF', pdfLocalPath, link.href);");

code = code.replace(/appendToCSV\('([^']+)', weekFolder, link\.text, `\$\{link\.text\} Transcript`, 'Transcript \.txt', transcriptUrl, link\.href\);/g,
"appendToCSV('$1', weekFolder, link.text + ' - ' + unitTitle, `${unitTitle} Transcript`, 'Transcript .txt', transcriptUrl, link.href);");

fs.writeFileSync('MIT_Learn_Courses/run_crawler.js', code);
console.log('Crawler updated to use sectionDir hierarchy');