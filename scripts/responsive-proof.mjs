#!/usr/bin/env node
// One-shot Playwright driver that proves out the responsive-layout fix
// (rail-responsive-fix branch) and the Cmd/Ctrl+Enter navigation fix.
// Not a test suite — screenshots + a short before/after pair are the
// proof, not assertions. Run it, look at docs/screenshots/responsive/*.png.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = resolve(root, 'docs/screenshots/responsive');

const WIDTHS = [400, 768, 1024, 1400];

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

function spawnCli(exampleFile) {
  return spawn(process.execPath, [resolve(root, 'bin/ask-questions.js'), '--file', exampleFile, '--no-open', '--no-ding'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
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

async function clickQuizOption(page, questionId, optionValue) {
  await page.evaluate((id) => {
    const card = [...document.querySelectorAll('.question-card')].find((item) => item.querySelector(`[data-question-id="${id}"]`));
    if (card) card.id = `${id}-card`;
  }, questionId);
  const options = page.locator(`#${questionId}-card .quiz-option`);
  await options.nth(QUESTION_OPTION_INDEX[questionId][optionValue]).click();
  await page.waitForTimeout(250);
}

// Walks one browser page through context -> question 2 -> review, capturing
// a screenshot at each stop, at the given viewport width.
async function captureWidth(browser, url, width) {
  const context = width === 768
    ? await browser.newContext({
        viewport: { width, height: 900 },
        recordVideo: { dir: shotsDir, size: { width, height: 900 } },
      })
    : await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.waitForSelector('#context-screen:not([hidden])');
    await page.screenshot({ path: resolve(shotsDir, `${width}-context.png`) });

    if (width === 768) {
      // Short hover/expand interaction recording: hover the collapsed
      // rail, hold briefly so the desktop hover-overlay animates in, then
      // move away so it retracts. At this width the rail is still full
      // desktop behavior (breakpoint is 800px) — this is the "does the
      // hover/pin overlay still work at intermediate widths" proof.
      await page.click('#start-questions');
      await page.waitForSelector('.question-card:not([hidden])');
      const railBox = await page.locator('#rail').boundingBox();
      await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2);
      await page.mouse.move(railBox.x + railBox.width / 2 + 1, railBox.y + railBox.height / 2 + 1);
      await page.waitForTimeout(600);
      await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + 400);
      await page.waitForTimeout(400);
    } else {
      await page.click('#start-questions');
      await page.waitForSelector('.question-card:not([hidden])');
    }

    // Navigate to question 2 (client-refusal) so a mid-flow question
    // screen is what's captured, not just question 1.
    await clickQuizOption(page, 'range-cap', 'b');
    await page.click('#next-question');
    await page.waitForSelector('.question-card:not([hidden])');
    await page.screenshot({ path: resolve(shotsDir, `${width}-question.png`) });

    // Answer the remaining required questions to reach the review screen.
    for (const [id, value] of [['client-refusal', 'c'], ['validation-order', 'b'], ['coverage-bounds', 'b'], ['covered-meaning', 'b'], ['total-ot-scope', 'a']]) {
      await clickQuizOption(page, id, value);
      const isLast = id === 'total-ot-scope';
      await page.click(isLast ? 'text=Review answers' : '#next-question');
      if (!isLast) await page.waitForSelector('.question-card:not([hidden])');
    }
    await page.waitForSelector('#review:not([hidden])');
    await page.screenshot({ path: resolve(shotsDir, `${width}-review.png`) });
  } finally {
    const video = page.video();
    await page.close();
    await context.close();
    if (video) {
      const { rename } = await import('node:fs/promises');
      const videoPath = await video.path();
      await rename(videoPath, resolve(shotsDir, '768-rail-interaction.webm')).catch(() => {});
    }
  }
}

// Proves the Cmd/Ctrl+Enter fix: examples/request.json has a `single`
// (radio-input) question first, which is the exact case that used to be
// broken — isEditableTarget(radio-input) was true, so the Cmd+Enter
// handler returned before ever checking metaKey/ctrlKey.
async function captureCmdEnterFix(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.waitForSelector('#context-screen:not([hidden])', { timeout: 5000 }).catch(() => {});
    const startButton = page.locator('#start-questions');
    if (await startButton.isVisible().catch(() => false)) await startButton.click();
    await page.waitForSelector('.question-card:not([hidden])');
    await page.click('.option input >> nth=0');
    await page.screenshot({ path: resolve(shotsDir, 'cmd-enter-before.png') });
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(shotsDir, 'cmd-enter-after.png') });
  } finally {
    await page.close();
    await context.close();
  }
}

async function main() {
  await mkdir(shotsDir, { recursive: true });

  const quizChild = spawnCli('examples/quiz.json');
  const quizUrl = await waitForUrl(quizChild);
  console.log(`Quiz session URL: ${quizUrl}`);
  const quizExit = new Promise((res) => quizChild.once('exit', res));

  const browser = await chromium.launch();
  for (const width of WIDTHS) {
    console.log(`Capturing width ${width}...`);
    await captureWidth(browser, quizUrl, width);
  }

  const requestChild = spawnCli('examples/request.json');
  const requestUrl = await waitForUrl(requestChild);
  console.log(`Request session URL: ${requestUrl}`);
  const requestExit = new Promise((res) => requestChild.once('exit', res));
  console.log('Capturing Cmd+Enter fix proof...');
  await captureCmdEnterFix(browser, requestUrl);

  await browser.close();
  quizChild.kill();
  requestChild.kill();
  await Promise.race([quizExit, new Promise((r) => setTimeout(r, 2000))]);
  await Promise.race([requestExit, new Promise((r) => setTimeout(r, 2000))]);

  console.log(`Done. Screenshots (and, at 768px, a hover-interaction recording) are under ${shotsDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
