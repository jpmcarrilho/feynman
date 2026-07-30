const fs = require('fs');
let code = fs.readFileSync('MIT_Learn_Courses/run_crawler.js.bak', 'utf8');

// Let's replace the whole extraction function block to be perfectly clean
const cleanExtractor = `function extractTextWithMathImagesTables(element) {
                    if (!element) return '';
                    const clone = element.cloneNode(true);
                    
                    // 1. MathJax
                    const mathRendered = clone.querySelectorAll('.MathJax_Preview, .MathJax_SVG, .MathJax, .MathJax_Display');
                    mathRendered.forEach(el => el.remove());
                    const mathScripts = clone.querySelectorAll('script[type^="math/tex"]');
                    mathScripts.forEach(script => {
                      const mathText = script.textContent;
                      const isDisplay = script.type.includes('mode=display');
                      const replacement = isDisplay ? '\\n$$ ' + mathText.trim() + ' $$\\n' : '\\\\(' + mathText.trim() + '\\\\)';
                      const textNode = document.createTextNode(replacement);
                      script.parentNode.replaceChild(textNode, script);
                    });
                    
                    // 2. Images -> Markdown
                    const images = clone.querySelectorAll('img');
                    images.forEach(img => {
                      const alt = img.getAttribute('alt') || 'image';
                      const src = img.getAttribute('src') || '';
                      if (src) {
                         const md = '\\n![' + alt + '](' + src + ')\\n';
                         const textNode = document.createTextNode(md);
                         img.parentNode.replaceChild(textNode, img);
                      }
                    });
                    
                    // 3. Tables -> Markdown
                    const tables = clone.querySelectorAll('table');
                    tables.forEach(table => {
                      let mdTable = '\\n';
                      const rows = Array.from(table.querySelectorAll('tr'));
                      rows.forEach((row, i) => {
                        const cols = Array.from(row.querySelectorAll('th, td'));
                        mdTable += '| ' + cols.map(c => c.innerText.trim().replace(/\\n/g, ' ')).join(' | ') + ' |\\n';
                        if (i === 0 && row.querySelectorAll('th').length > 0) {
                          mdTable += '|' + cols.map(() => '---').join('|') + '|\\n';
                        }
                      });
                      mdTable += '\\n';
                      const pre = document.createElement('pre');
                      pre.innerText = mdTable;
                      table.parentNode.replaceChild(pre, table);
                    });
                    
                    const tempDiv = document.createElement('div');
                    tempDiv.style.position = 'absolute';
                    tempDiv.style.left = '-9999px';
                    tempDiv.appendChild(clone);
                    document.body.appendChild(tempDiv);
                    const extractedText = tempDiv.innerText;
                    tempDiv.remove();
                    return extractedText.trim();
                  }`;

// In the backup file, the function wasn't there initially. The backup file is the *original* file before my previous buggy replace.
// Wait, my previous `cp` was AFTER the buggy replace, so `run_crawler.js.bak` has `function extractTextWithMathImagesTables`!
code = code.replace(/function extractTextWithMathImagesTables[\s\S]*?return extractedText\.trim\(\);\n                  }/g, cleanExtractor);


// Fix directory creation, etc
// We will replace `const skipWeekly = ...`
code = code.replace(/const skipWeekly = fs\.existsSync\(targetDir\) && fs\.readdirSync\(targetDir\)\.filter\(f => f\.endsWith\('\.txt'\)\)\.length >= section\.links\.length;/g,
'const skipWeekly = fs.existsSync(targetDir) && fs.readdirSync(targetDir).filter(f => fs.statSync(path.join(targetDir, f)).isDirectory()).length >= section.links.length;');

// Replace path and mkdir logic
code = code.replace(/const txtFilePath = path\.join\(targetDir, `\$\{link\.text\.replace\(\/\[\^a-zA-Z0-9\]\/g, '_'\)\}\.txt`\);\s+\/\/ Skip if this specific sequential text file already has content \(crawled previously\)\s+if \(fs\.existsSync\(txtFilePath\) && fs\.statSync\(txtFilePath\)\.size > 500\) \{\s+console\.log\(`  ⏭️ Skipping completed sequential: \$\{link\.text\}`\);\s+continue;\s+\}\s+console\.log\(`  🔗 Crawling Sequential: \$\{link\.text\}`\);\s+try \{\s+fs\.writeFileSync\(txtFilePath, `==================================================\\nSEQUENTIAL: \$\{link\.text\}\\nURL: \$\{link\.href\}\\n==================================================\\n\\n`\);/g,
`const safeResourceName = link.text.replace(/[^a-zA-Z0-9]/g, '_');
      const lessonDir = path.join(targetDir, safeResourceName);
      const indexFilePath = path.join(lessonDir, 'index.md');
      
      // Skip if this specific sequential text file already has content (crawled previously)
      if (!process.argv.includes('--force') && fs.existsSync(indexFilePath) && fs.statSync(indexFilePath).size > 50) {
        console.log(\`  ⏭️ Skipping completed sequential: \${link.text}\`);
        continue;
      }
      
      console.log(\`  🔗 Crawling Sequential: \${link.text}\`);
      
      try {
        if (!fs.existsSync(lessonDir)) fs.mkdirSync(lessonDir, { recursive: true });
        fs.writeFileSync(indexFilePath, \`# \${link.text}\\nURL: \${link.href}\\n\\n\`);`);

// Replace PDF block
code = code.replace(/fs\.appendFileSync\(txtFilePath, `\[SLIDES PDF\]\\nSlide URL: \$\{slideUrl\}\\n\\n`\);\s+\/\/ Downloader inside crawler loop \(Real-Time PDF binary downloading!\)\s+const safeResourceName = link\.text\.replace\(\/\[\^a-zA-Z0-9\]\/g, '_'\);\s+const pdfLocalPath = path\.join\(targetDir, `\$\{safeResourceName\}_Slides\.pdf`\);/g,
`fs.writeFileSync(path.join(lessonDir, 'Slides.md'), \`[SLIDES PDF]\\nSlide URL: \${slideUrl}\\n\\n\`);
                  
                  // Downloader inside crawler loop (Real-Time PDF binary downloading!)
                  const pdfLocalPath = path.join(lessonDir, 'Slides.pdf');`);

// Replace transcript block
code = code.replace(/fs\.appendFileSync\(txtFilePath, `\[TRANSCRIPT\]\\n\$\{transcriptText\}\\n\\n`\);\s+appendToCSV\('([^']+)', weekFolder, link\.text, `\$\{link\.text\} Transcript`, 'Transcript \.txt', transcriptUrl, link\.href\);/g,
`fs.writeFileSync(path.join(lessonDir, 'Transcript.md'), transcriptText);
                    appendToCSV('$1', weekFolder, link.text, \`\${link.text} Transcript\`, 'Transcript .txt', transcriptUrl, link.href);`);

// Replace problem appending block
// Note: we need to handle the problemData extraction replacing since I changed it to `probPath`
code = code.replace(/console\.log\(`      Extracted \$\{problemData\.length\} questions`\);\s+for \(const prob of problemData\) \{\s+let probBlock = `\[EXERCISE\/PROBLEM\]\\nQuestion:\\n\$\{prob\.questionText\}\\n\\nChoices:\\n`;\s+for \(const ch of prob\.choices\) \{\s+probBlock \+= `- \[\$\{ch\.isCorrect \? 'x' : ' '\}\] \$\{ch\.text\}\\n`;\s+\}\s+if \(prob\.solutionText\) \{\s+probBlock \+= `\\nExplanation\/Solution:\\n\$\{prob\.solutionText\}\\n`;\s+\}\s+fs\.appendFileSync\(txtFilePath, probBlock \+ '\\n\\n'\);\s+\}\s+appendToCSV\('([^']+)', weekFolder, link\.text, `\$\{link\.text\} Exercise Questions`, 'Exercise Content & Solutions', txtFilePath, link\.href\);/g,
`console.log(\`      Extracted \${problemData.length} questions\`);
                  let probIndex = 1;
                  for (const prob of problemData) {
                    let probBlock = \`# Question\\n\${prob.questionText}\\n\\n## Choices\\n\`;
                    for (const ch of prob.choices) {
                      probBlock += \`- [\${ch.isCorrect ? 'x' : ' '}] \${ch.text}\\n\`;
                    }
                    if (prob.solutionText) {
                      probBlock += \`\\n## Explanation/Solution\\n\${prob.solutionText}\\n\`;
                    }
                    const probPath = path.join(lessonDir, \`Exercise_\${probIndex}.md\`);
                    fs.writeFileSync(probPath, probBlock);
                    probIndex++;
                  }
                  appendToCSV('$1', weekFolder, link.text, \`\${link.text} Exercise Questions\`, 'Exercise Content & Solutions', lessonDir, link.href);`);

// Also need to handle the original extraction block case if the regex above didn't match
// Actually, `run_crawler.js.bak` has my *old* buggy code because I ran `cp` *after* the buggy `node -e` replaced the code.
// The regexes should work. Let's see if we get success.

fs.writeFileSync('MIT_Learn_Courses/run_crawler.js', code);
console.log('Script patched successfully!');