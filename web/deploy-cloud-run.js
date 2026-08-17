const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 1. Read .env file to get variables
const envPath = path.join('.env');
if (!fs.existsSync(envPath)) {
  console.error('Error: web/.env file is missing!');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const lines = envContent.split('\n');
const env = {};

lines.forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const firstEq = trimmed.indexOf('=');
    if (firstEq !== -1) {
      const key = trimmed.substring(0, firstEq).trim();
      const val = trimmed.substring(firstEq + 1).trim();
      // strip quotes if any
      env[key] = val.replace(/^["']|["']$/g, '');
    }
  }
});

const appPasscode = env['APP_PASSCODE'];
const googleApiKey = env['GOOGLE_API_KEY'];

if (!googleApiKey) {
  console.error('Error: GOOGLE_API_KEY is missing in .env!');
  process.exit(1);
}
if (!appPasscode) {
  console.error('Error: APP_PASSCODE is missing in .env!');
  process.exit(1);
}

console.log('Successfully loaded secrets from .env securely (no secrets printed to console).');

// 2. Build the env vars string
const envVars = [
  `APP_PASSCODE=${appPasscode}`,
  `GOOGLE_API_KEY=${googleApiKey}`,
  `DATABASE_URL=file:./dev.db`
].join(',');

const activeProject = spawnSync('gcloud', ['config', 'get-value', 'project'], { encoding: 'utf8' }).stdout.trim();
console.log(`Deploying to Google Cloud Run (project: ${activeProject || 'unknown'}, region: us-central1)...`);
console.log('This will submit your workspace to Cloud Build, trigger "npm run build" (with Prisma generation), and deploy.');

const args = [
  'run', 'deploy', 'feynman-study-hub',
  '--source', '.',
  '--region', 'us-central1',
  '--allow-unauthenticated',
  '--set-env-vars', envVars
];

// Spawn the deployment process
const result = spawnSync('gcloud', args, { stdio: 'inherit', shell: true });

if (result.status === 0) {
  console.log('=========================================');
  console.log('🎉 DEPLOYMENT SUCCESSFUL!');
  console.log('=========================================');
} else {
  console.error('❌ DEPLOYMENT FAILED with exit code:', result.status);
  process.exit(result.status || 1);
}
