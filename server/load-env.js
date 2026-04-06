// Load environment variables from .env before other imports execute.
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPath = path.join(__dirname, '../.env');

// Read existing .env (or start empty)
let envContent = '';
try {
  envContent = fs.readFileSync(envPath, 'utf8');
} catch {
  // .env does not exist yet – will be created below if needed
}

// Parse existing .env into process.env (do not overwrite already-set vars)
envContent.split('\n').forEach(line => {
  const trimmedLine = line.trim();
  if (trimmedLine && !trimmedLine.startsWith('#')) {
    const [key, ...valueParts] = trimmedLine.split('=');
    if (key && valueParts.length > 0 && !process.env[key]) {
      process.env[key] = valueParts.join('=').trim();
    }
  }
});

// Auto-generate and persist JWT_SECRET so tokens survive server restarts
if (!process.env.JWT_SECRET) {
  const generated = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = generated;

  // Append (or create) the .env file with the new secret
  const line = `JWT_SECRET=${generated}\n`;
  try {
    if (envContent && !envContent.endsWith('\n')) {
      fs.appendFileSync(envPath, '\n' + line, 'utf8');
    } else {
      fs.appendFileSync(envPath, line, 'utf8');
    }
  } catch (e) {
    console.warn('[WARN] Could not persist JWT_SECRET to .env:', e.message);
  }
}

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = path.join(os.homedir(), '.openwork', 'auth.db');
}
