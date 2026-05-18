const fs = require('fs');
const path = require('path');

const testResultsDir = path.join(__dirname, 'test-results');
if (!fs.existsSync(testResultsDir)) {
  console.log('No test-results directory');
  process.exit(0);
}

const dirs = fs.readdirSync(testResultsDir).filter(d => d.includes('categories'));
const summary = {};

for (const dir of dirs) {
  const ecPath = path.join(testResultsDir, dir, 'error-context.md');
  if (!fs.existsSync(ecPath)) continue;
  const content = fs.readFileSync(ecPath, 'utf-8');
  
  const nameMatch = content.match(/Name: categories\.spec\.ts >> (.+)/);
  const testName = nameMatch ? nameMatch[1].trim() : 'unknown';
  
  const expMatch = content.match(/Expected:\s*(\S+)/);
  const recMatch = content.match(/Received:\s*(\S+)/);
  
  let key;
  if (expMatch && recMatch) {
    key = `${testName} | Expected: ${expMatch[1]} | Received: ${recMatch[1]}`;
  } else if (content.includes('Error:')) {
    const errMatch = content.match(/Error: (.+)/);
    key = `${testName} | ${errMatch ? errMatch[1].substring(0, 80) : 'Error'}`;
  } else {
    key = testName;
  }
  
  if (!summary[key]) summary[key] = 0;
  summary[key]++;
}

console.log('='.repeat(70));
console.log('FAILURE SUMMARY FOR categories.spec.ts');
console.log('='.repeat(70));
for (const [key, count] of Object.entries(summary).sort()) {
  console.log(`${count} x | ${key}`);
}
console.log('='.repeat(70));
console.log(`Total unique failures: ${Object.keys(summary).length}`);
