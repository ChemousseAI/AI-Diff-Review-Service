'use strict';

const fs = require('fs');
const path = require('path');

// Minimal drop-in for dotenv: reads KEY=VALUE lines from .env in the CWD
// (if present) without overriding variables already set in the real
// environment. Kept dependency-free on purpose.
function loadEnv(filePath) {
  const envPath = filePath || path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

module.exports = { loadEnv };
