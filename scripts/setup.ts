import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Interactive first-run setup. Asks a few plain-language questions and writes
 * the answers to `.env`. Safe to re-run: existing values become the defaults,
 * and any variables this script does not know about are preserved.
 */

const ENV_PATH = path.resolve('.env');

interface Question {
  key: string;
  prompt: string;
  help: string;
  fallback: string;
  normalize?: (value: string) => string;
  /** Optional reachability check. Advisory only — a failure never blocks setup. */
  check?: (value: string) => Promise<CheckResult>;
}

type CheckResult = { ok: true } | { ok: false; reason: string };

const PROBE_TIMEOUT_MS = 5000;

/**
 * Ask the device for its endpoint manifest. This is the same plain GET the
 * Jamcorder's own extensions page uses, so it is a safe liveness probe. We only
 * look at the status; the body is never read.
 */
async function probeDevice(baseUrl: string): Promise<CheckResult> {
  try {
    const response = await fetch(`${baseUrl}/api/meta/endpoints`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { ok: false, reason: `the device answered with HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeProbeError(error) };
  }
}

function describeProbeError(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `nothing answered within ${PROBE_TIMEOUT_MS / 1000} seconds`;
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'that address could not be found on your network';
    case 'ECONNREFUSED':
      return 'the address exists but refused the connection';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'that address is not reachable from this computer';
    default: {
      // A fetch failure's own message is just "fetch failed", which tells a
      // reader nothing; the useful detail is on the cause.
      const detail = (error as { cause?: { message?: string } })?.cause?.message;
      if (detail) return `could not connect (${detail})`;
      return error instanceof Error && error.message !== 'fetch failed'
        ? error.message
        : 'could not connect to that address';
    }
  }
}

function normalizeUrl(value: string): string {
  let url = value.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url;
}

function normalizePath(value: string): string {
  let result = value.trim().replace(/\/+$/, '');
  // Node never expands `~`, so a path like `~/Music` would create a literal
  // directory named `~`. Typing `~` is natural, so expand it here.
  if (result === '~' || result.startsWith('~/')) {
    result = path.join(os.homedir(), result.slice(1));
  }
  return result;
}

const QUESTIONS: Question[] = [
  {
    key: 'JAMCORDER_URL',
    prompt: 'Address of your Jamcorder',
    help: 'Most Jamcorders answer to jamcorder.local. If that does not work, use\n'
      + 'the device\'s IP address (for example 192.168.1.50).',
    fallback: 'http://jamcorder.local',
    normalize: normalizeUrl,
    check: probeDevice
  },
  {
    key: 'JAMCODA_DB_PATH',
    prompt: 'Where should JamCoda keep its database file?',
    help: 'This small file holds your annotations and review history.\n'
      + 'It is created automatically. Keep the default unless you have a reason not to.',
    fallback: './data/jamcoda.db',
    normalize: normalizePath
  },
  {
    key: 'JAMCODA_MIDI_DIR',
    prompt: 'Where should synced MIDI recordings be stored?',
    help: 'Recordings copied from your Jamcorder go here, in dated folders.\n'
      + 'This can be a folder outside the project, such as an external drive.',
    fallback: './data/midi',
    normalize: normalizePath
  }
];

/** Keys this script manages. Anything else in .env is left untouched. */
const MANAGED_KEYS = new Set(QUESTIONS.map((q) => q.key));

function parseEnvFile(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return values;
}

/** Lines in an existing .env that this script does not manage, so we can keep them. */
function unmanagedLines(contents: string): string[] {
  const kept: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (!MANAGED_KEYS.has(line.slice(0, eq).trim())) {
      kept.push(rawLine);
    }
  }
  return kept;
}

function renderEnvFile(answers: Map<string, string>, preserved: string[]): string {
  const lines = [
    '# Written by `npm run setup`. Edit by hand or re-run that command.',
    '',
    '# Address of your Jamcorder device.',
    `JAMCORDER_URL=${answers.get('JAMCORDER_URL')}`,
    '',
    '# Where the SQLite database lives.',
    `JAMCODA_DB_PATH=${answers.get('JAMCODA_DB_PATH')}`,
    '',
    '# Where synced MIDI recordings are stored.',
    `JAMCODA_MIDI_DIR=${answers.get('JAMCODA_MIDI_DIR')}`
  ];

  if (preserved.length > 0) {
    lines.push('', '# Kept from your previous .env', ...preserved);
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error(
      'npm run setup needs an interactive terminal.\n'
      + 'Copy .env.example to .env and edit it by hand instead.'
    );
    process.exitCode = 1;
    return;
  }

  const existingContents = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const existing = parseEnvFile(existingContents);
  const preserved = unmanagedLines(existingContents);

  console.log('\nJamCoda setup\n');
  console.log('This asks a few questions and writes your answers to a .env file.');
  console.log('Press Enter to accept the suggested answer in [brackets].');
  if (existingContents) {
    console.log('\nFound an existing .env — your current settings are the suggestions.');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers = new Map<string, string>();

  try {
    for (const question of QUESTIONS) {
      const suggested = existing.get(question.key) || question.fallback;
      console.log(`\n${question.help}`);

      let value = '';
      for (;;) {
        const reply = await rl.question(`${question.prompt} [${suggested}]: `);
        const chosen = reply.trim() === '' ? suggested : reply;
        value = question.normalize ? question.normalize(chosen) : chosen.trim();

        if (!question.check) break;

        process.stdout.write(`  Looking for a Jamcorder at ${value} ... `);
        const result = await question.check(value);
        if (result.ok) {
          console.log('found it.');
          break;
        }

        console.log(`no luck — ${result.reason}.`);
        console.log('  If your Jamcorder is switched off or not on this network yet,');
        console.log('  that is fine — you can save this address and connect later.');
        const retry = await rl.question('  Enter a different address? [y/N]: ');
        if (!/^y(es)?$/i.test(retry.trim())) {
          break;
        }
      }
      answers.set(question.key, value);
    }

    console.log('\nThis will be written to .env:\n');
    for (const question of QUESTIONS) {
      const value = answers.get(question.key) as string;
      // Show where a relative path actually lands, so a typo is obvious here
      // rather than at first run.
      const resolved = question.normalize === normalizePath && !path.isAbsolute(value)
        ? `  ->  ${path.resolve(value)}`
        : '';
      console.log(`  ${question.key}=${value}${resolved}`);
    }
    if (preserved.length > 0) {
      console.log(`\n  (${preserved.length} other setting(s) in your .env will be kept)`);
    }

    const confirm = await rl.question('\nSave these settings? [Y/n]: ');
    if (confirm.trim() !== '' && !/^y(es)?$/i.test(confirm.trim())) {
      console.log('\nNothing was written. Run `npm run setup` again when ready.');
      return;
    }
  } finally {
    rl.close();
  }

  writeFileSync(ENV_PATH, renderEnvFile(answers, preserved), 'utf8');

  console.log(`\nSaved ${ENV_PATH}`);
  console.log('\nNext steps:');
  console.log('  npm run db:migrate    set up the database');
  console.log('  npm run dev           start JamCoda, then open http://localhost:5173');
  console.log('');
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
