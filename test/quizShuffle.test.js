import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateAnswers, validatePayload } from '../lib/contract.js';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
// app.js is a browser module with a top-level fetch, so the test lifts the two pieces that matter
// (the helper and the once-per-load pass over the session) and runs them on their own.
const helper = app.match(/function shuffled\(items, random = Math\.random\) \{[\s\S]*?\n\}\n/)?.[0];
const pass = app.match(/session\.questions\.forEach\(\(question\) => \{\n  if \(question\.type === 'quiz'\)[\s\S]*?\n\}\);\n/)?.[0];
assert.ok(helper && pass, 'web/app.js must keep the shuffled helper and the load-time pass');
const load = new Function('session', 'random', `${helper.replace('random = Math.random', 'random = globalThis.__r')}\nglobalThis.__r = random;\n${pass}\nreturn session;`);

const payload = () => ({
  version: 1,
  questions: [{
    id: 'q1', prompt: 'p', type: 'quiz', answer: 'B',
    options: ['A', 'B', 'C', 'D', 'E', 'F'].map((value) => ({ value, label: `text ${value}`, ...(value === 'B' ? {} : { whyWrong: `no ${value}` }) })),
  }, { id: 'q2', prompt: 'pick', type: 'single', options: [{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }] }],
});
const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test('two page loads can show quiz options in different orders', () => {
  const orders = new Set();
  for (let seed = 1; seed <= 20; seed += 1) {
    orders.add(load(payload(), seeded(seed)).questions[0].options.map((o) => o.value).join(''));
  }
  assert.ok(orders.size > 1, 'every load gave the same order');
});

test('a shuffle keeps every option and its label, and leaves non-quiz questions alone', () => {
  const original = payload();
  const loaded = load(payload(), seeded(7));
  assert.deepEqual(loaded.questions[0].options.map((o) => o.value).sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
  for (const o of loaded.questions[0].options) assert.deepEqual(o, original.questions[0].options.find((x) => x.value === o.value));
  assert.deepEqual(loaded.questions[1].options, original.questions[1].options);
});

test('grading is by stored value, so the displayed order does not change the result', () => {
  const sent = payload();
  validatePayload(sent);
  const shown = load(payload(), seeded(3)).questions[0].options;
  const pickByText = (text) => shown.find((o) => o.label === text).value;
  const grade = (text) => validateAnswers(sent, [{ questionId: 'q1', value: pickByText(text), notes: '' }, { questionId: 'q2', value: 'x', notes: '' }]).q1.correct;
  assert.equal(grade('text B'), true);
  assert.equal(grade('text C'), false);
});

test('the shuffle runs once, before any question renders, and the form shows no letters', () => {
  assert.ok(app.indexOf(pass) < app.indexOf('function renderQuizQuestion('), 'shuffle must come before rendering');
  assert.equal(app.split('shuffled(').length - 1, 2, 'shuffled is defined once and called once');
  // Everything Reid reads names an option by its label. The stored letter only goes into the answers sent to the server.
  assert.doesNotMatch(app, /textContent: `[^`]*\$\{(?:option|candidate|chosenOption|correctOption|state)\.value\}/);
});
