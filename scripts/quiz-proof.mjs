#!/usr/bin/env node
// One-shot Playwright driver that proves the rail redesign + quiz mode work
// end to end against examples/quiz.json. Not a test suite — Reid asked for
// screenshots + captured result JSON as the proof, not assertions. Run it,
// look at docs/screenshots/quiz/*.png and result.json.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = resolve(root, 'docs/screenshots/quiz');

async function waitForUrl(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/ask-questions: (http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/)/);
      if (match) {
        child.stderr.off('data', onData);
        resolvePromise(match[1]);
      }
    };
    child.stderr.on('data', onData);
    child.once('error', rejectPromise);
    setTimeout(() => rejectPromise(new Error('Timed out waiting for the session URL on stderr')), 15000);
  });
}

// examples/quiz.json option order for each question, value -> index.
const QUESTION_OPTION_INDEX = {
  'range-cap': { a: 0, b: 1, c: 2, d: 3 },
  'client-refusal': { a: 0, b: 1, c: 2, d: 3 },
  'validation-order': { a: 0, b: 1, c: 2, d: 3 },
  'coverage-bounds': { a: 0, b: 1, c: 2, d: 3 },
  'covered-meaning': { a: 0, b: 1, c: 2, d: 3 },
  'total-ot-scope': { a: 0, b: 1, c: 2, d: 3 },
};

// Each option is a <button class="quiz-option"> in document order; give each
// question card an id so this script can find the right one without
// guessing selector order across the whole page.
async function clickQuizOption(page, questionId, optionValue) {
  await page.evaluate((id) => {
    const card = [...document.querySelectorAll('.question-card')].find((item) => item.querySelector(`[data-question-id="${id}"]`));
    if (card) card.id = `${id}-card`;
  }, questionId);
  const options = page.locator(`#${questionId}-card .quiz-option`);
  await options.nth(QUESTION_OPTION_INDEX[questionId][optionValue]).click();
  // .option (shared with quiz options) transitions border-color/background
  // over 150ms; wait it out so the correct/wrong highlight has actually
  // painted before the next screenshot.
  await page.waitForTimeout(250);
}

async function main() {
  await mkdir(shotsDir, { recursive: true });

  const child = spawn(process.execPath, [resolve(root, 'bin/ask-questions.js'), '--file', 'examples/quiz.json', '--no-open', '--no-ding'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  let stderrLog = '';
  child.stderr.on('data', (chunk) => { stderrLog += chunk.toString(); });

  const url = await waitForUrl(child);
  console.log(`Session URL: ${url}`);
  const childExit = new Promise((resolvePromise) => child.once('exit', resolvePromise));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url);
    await page.waitForSelector('#context-screen:not([hidden])');
    await page.screenshot({ path: resolve(shotsDir, '01-context.png'), fullPage: true });

    await page.click('#start-questions');
    await page.waitForSelector('.question-card:not([hidden])');

    // Q1: range-cap — answer correctly (spec answer is "b").
    await clickQuizOption(page, 'range-cap', 'b');
    await page.screenshot({ path: resolve(shotsDir, '02-question-correct.png'), fullPage: true });
    await page.click('#next-question');

    // Q2: client-refusal — answer incorrectly on purpose (spec answer is "c").
    await page.waitForSelector('.question-card:not([hidden])');
    await clickQuizOption(page, 'client-refusal', 'a');
    await page.screenshot({ path: resolve(shotsDir, '03-question-wrong.png'), fullPage: true });
    await page.click('#next-question');

    // Q3: validation-order — answer correctly, then disagree with the spec's answer.
    await page.waitForSelector('.question-card:not([hidden])');
    await clickQuizOption(page, 'validation-order', 'b');
    await page.click('#validation-order-card .quiz-disagree-toggle');
    await page.fill('#validation-order-card .notes', 'I think FORBIDDEN-before-INVALID_RANGE is the wrong order for a UX reason: the manager fixes nothing by hearing FORBIDDEN when the range is also too big.');
    await page.screenshot({ path: resolve(shotsDir, '04-question-disagree.png'), fullPage: true });
    await page.click('#next-question');

    // Answer the remaining questions plainly (all correct) so the review
    // screen and score reflect a realistic run: 1 disagree, 1 wrong, rest correct.
    for (const [id, value] of [['coverage-bounds', 'b'], ['covered-meaning', 'b'], ['total-ot-scope', 'a']]) {
      await page.waitForSelector('.question-card:not([hidden])');
      await clickQuizOption(page, id, value);
      const isLast = id === 'total-ot-scope';
      await page.click(isLast ? 'text=Review answers' : '#next-question');
    }

    await page.waitForSelector('#review:not([hidden])');
    await page.screenshot({ path: resolve(shotsDir, '05-review.png'), fullPage: true });

    await page.click('button[type="submit"]');
    await page.waitForSelector('#completion:not([hidden])', { timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: resolve(shotsDir, '06-submitted.png'), fullPage: true });
  } finally {
    await browser.close();
  }

  const exitCode = await childExit;
  await writeFile(resolve(shotsDir, 'result.json'), `${stdout.trim()}\n`);
  console.log(`CLI exit code: ${exitCode}`);
  console.log(`Captured stdout: ${stdout.trim()}`);
  if (!stdout.trim()) console.log(`stderr log for debugging:\n${stderrLog}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
