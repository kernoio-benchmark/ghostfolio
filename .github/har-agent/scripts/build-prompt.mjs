// Fill .github/har-agent/prompt.md with the issue and the slot URLs.
// Usage: node build-prompt.mjs <issue.json> <out.md>
// Env: AGENT_ID, FRONTEND_URL, API_URL
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [issueFile, outFile] = process.argv.slice(2);
const issue = JSON.parse(fs.readFileSync(issueFile, 'utf8'));
const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(here, '..', 'prompt.md'), 'utf8');

const values = {
  AGENT_ID: process.env.AGENT_ID,
  FRONTEND_URL: process.env.FRONTEND_URL,
  API_URL: process.env.API_URL,
  ISSUE_NUMBER: String(issue.number),
  ISSUE_URL: issue.url,
  ISSUE_TITLE: issue.title,
  // Keep the body from closing the <issue> wrapper early.
  ISSUE_BODY: (issue.body || '(empty)').replaceAll('</issue>', '<\\/issue>')
};
const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
  if (values[key] === undefined)
    throw new Error(`prompt.md placeholder ${m} has no value`);
  return values[key];
});
fs.writeFileSync(outFile, out);
