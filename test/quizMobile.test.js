import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');

// app.js is a browser module with a top-level fetch, so the test lifts the helper on its own.
const helper = app.match(/function stripFinalPeriod\(text\) \{[\s\S]*?\n\}\n/)?.[0];
assert.ok(helper, 'web/app.js must keep the stripFinalPeriod helper');
const stripFinalPeriod = new Function(`${helper}\nreturn stripFinalPeriod;`)();

// The CSS rules inside the phone block(s) (max-width: 800px), as one string.
const narrowCss = [...css.matchAll(/@media \(max-width: 800px\) \{([\s\S]*?)\n\}\n/g)].map((m) => m[1]).join('\n');
const withoutNarrow = css.replace(/@media \(max-width: 800px\) \{[\s\S]*?\n\}\n/g, '');

test('the reveal does not print a double period after a label that ends in one', () => {
  assert.equal(stripFinalPeriod('both sides.'), 'both sides');
  assert.equal(stripFinalPeriod('both sides'), 'both sides');
  assert.equal(stripFinalPeriod('both sides...  '), 'both sides');
  assert.match(app, /the spec says: \$\{stripFinalPeriod\(correctOption/);
  assert.match(app, /the spec says: \$\{stripFinalPeriod\(entry\.correctLabel/);
});

test('the documents pane is not opened by a quiz answer at 800 px or narrower', () => {
  assert.match(app, /if \(window\.innerWidth > 800\) docPaneOpen = true;/);
});

test('the quiz review is folded on a phone and open on desktop', () => {
  assert.match(app, /className: 'review-fold', open: !narrowScreen\.matches/);
  assert.match(app, /className: 'quiz-score-detail', open: !narrowScreen\.matches/);
  // Desktop CSS hides the summary rows, so the open desktop review reads as before.
  assert.match(withoutNarrow, /\.quiz-score-detail > summary, \.review-fold > summary \{ display: none; \}/);
});

test('the phone block keeps the actions row visible, with 48 px buttons and no copy buttons', () => {
  assert.match(narrowCss, /\.actions \{ position: sticky; bottom: 0;/);
  assert.match(narrowCss, /\.actions button \{ min-height: 48px; \}/);
  assert.match(narrowCss, /#copy-json, \.actions #copy-quiz-summary \{ display: none; \}/);
  assert.match(narrowCss, /\.header-chips \{ display: none; \}/);
  assert.match(narrowCss, /\.rail-mark \{[^}]*width: 44px; height: 44px;/);
  assert.match(narrowCss, /\.question-card > legend \{ float: left; width: 100%;/);
  assert.match(narrowCss, /\.content-row \{[^}]*overflow: visible;/);
});

test('hover tints apply only where the device can hover', () => {
  // The rail's hover expansion is layout, not a tint, and stays as it was.
  const loose = css.split('\n').filter((line) => /:hover/.test(line) && !/\.rail:hover/.test(line) && !line.startsWith('@media (hover: hover)'));
  assert.deepEqual(loose, []);
});
