// Reader for the per-user presence record that `tg presence` writes. Keep path and format in
// step with telegram/src/presence.ts: ~/.maestro/presence.json, or $MAESTRO_PRESENCE_FILE.
//   { version: 1, state: 'away'|'present', note, setBy, setAt, expiresAt }
// An away record past expiresAt reads as present. Reading never rewrites the file.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function presenceFile() {
  return process.env.MAESTRO_PRESENCE_FILE || resolve(homedir(), '.maestro', 'presence.json');
}

export function readPresence(now = new Date(), file = presenceFile()) {
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { state: 'present', reason: 'unset', record: null };
  }
  if (record?.version !== 1 || (record.state !== 'away' && record.state !== 'present')) {
    return { state: 'present', reason: 'unset', record: null };
  }
  if (record.state === 'away' && record.expiresAt) {
    const expires = Date.parse(record.expiresAt);
    if (Number.isFinite(expires) && now.getTime() >= expires) return { state: 'present', reason: 'expired', record };
  }
  return { state: record.state, reason: 'recorded', record };
}

function shellQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`;
}

// The tg command that asks the same payload over Telegram. tg ask takes the same payload
// schema and the same --file / --json / stdin inputs.
export function telegramCommandFor(args) {
  if (args.file !== undefined) return `tg ask --file ${shellQuote(args.file)}`;
  if (args.json !== undefined) return `tg ask --json ${shellQuote(args.json)}`;
  return 'tg ask   # pass the same payload on stdin';
}

// Best effort and never throws: does the payload the caller was about to launch hold a quiz
// question? tg ask accepts every other question type, but not quiz.
function hasQuizQuestion(args) {
  try {
    const source = args.json !== undefined ? args.json : args.file !== undefined ? readFileSync(resolve(process.cwd(), args.file), 'utf8') : undefined;
    const questions = source === undefined ? [] : JSON.parse(source).questions;
    return Array.isArray(questions) && questions.some((question) => question?.type === 'quiz');
  } catch {
    return false;
  }
}

export function refusalMessage(reading, args) {
  const { record } = reading;
  const lines = [
    `ask-questions: refused. Reid is away (recorded ${record.setAt} by ${record.setBy}${record.expiresAt ? `, until ${record.expiresAt}` : ''}).`,
  ];
  if (record.note) lines.push(`Presence note: ${record.note}`);
  lines.push('Ask over Telegram instead, with the same payload:');
  lines.push(`  ${telegramCommandFor(args)}`);
  if (hasQuizQuestion(args)) lines.push('tg ask rejects type "quiz" questions: change them to type "single" and drop answer, why, cite and allowDisagree first.');
  lines.push('If Reid is at the desk and the record is stale, rerun with --ignore-presence, or run: tg presence present');
  return `${lines.join('\n')}\n`;
}
