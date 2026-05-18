const fs = require('fs');
const path = require('path');

const e2eDir = path.join(__dirname, 'e2e');
const files = fs.readdirSync(e2eDir).filter(f => f.endsWith('.spec.ts'));

let changed = 0;
files.forEach(file => {
    const filePath = path.join(e2eDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    const original = content;
    
    // 1. Replace BASE_URL from localhost:3000 to localhost:8080 (frontend)
    content = content.replace(/const BASE_URL = 'http:\/\/localhost:3000'/g, "const BASE_URL = 'http://localhost:8080'");
    
    // 2. Replace API fetch URLs: ${BASE_URL}/api/v1/... -> http://localhost:3001/api/v1/...
    content = content.replace(/fetch\(`\$\{BASE_URL\}\/api\/v1/g, 'fetch(`http://localhost:3001/api/v1');
    
    // 3. Replace API fetch URLs without v1: ${BASE_URL}/api/... -> http://localhost:3001/api/v1/...
    content = content.replace(/fetch\(`\$\{BASE_URL\}\/api\/(?!v1)/g, 'fetch(`http://localhost:3001/api/v1/');
    
    // 4. Handle apiLogin patterns
    content = content.replace(/`\$\{BASE_URL\}\/api\/v1\/auth\/login`/g, '`http://localhost:3001/api/v1/auth/login`');
    content = content.replace(/`\$\{BASE_URL\}\/api\/auth\/login`/g, '`http://localhost:3001/api/v1/auth/login`');
    
    // 5. Handle other direct API URLs in backticks
    content = content.replace(/`\$\{BASE_URL\}\/api\/v1\//g, '`http://localhost:3001/api/v1/');
    content = content.replace(/`\$\{BASE_URL\}\/api\/(?!v1)/g, '`http://localhost:3001/api/v1/');
    
    if (content !== original) {
        fs.writeFileSync(filePath, content);
        changed++;
        console.log(`Updated: ${file}`);
    }
});

console.log(`Total files updated: ${changed}`);
