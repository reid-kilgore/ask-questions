import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');

// app.js is a browser module with a top-level fetch, so the test lifts the cancel block on its own
// and runs it against small fake elements. Nothing here starts a browser.
const block = app.match(/const CANCEL_CONFIRM_DELAY_MS[\s\S]*?function openCancelConfirm\(\) \{[\s\S]*?\ncancelButton\.addEventListener\('click', openCancelConfirm\);\ncancelKeepButton\.addEventListener\('click'[^\n]*\ncancelYesButton\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);\n/)?.[0];
assert.ok(block, 'web/app.js must keep the cancel confirmation block');

function fakeElement(extra = {}) {
  const listeners = {};
  const classes = new Set();
  return {
    hidden: true, ariaExpanded: 'false', focused: false, listeners, classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    focus() { this.focused = true; },
    ...extra,
  };
}

function setup() {
  const cancelButton = fakeElement({ hidden: false });
  const cancelConfirm = fakeElement();
  const cancelKeepButton = fakeElement();
  const cancelYesButton = fakeElement();
  const actions = fakeElement();
  const requests = [];
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    elapse: () => timers.forEach((t) => { const fn = t.fn; t.fn = null; fn?.(); }),
    timers,
  };
  const document = {
    querySelector: (selector) => (selector === '.actions' ? actions : null),
    addEventListener() {},
  };
  const completeRequest = async (...args) => { requests.push(args); };
  new Function('cancelButton', 'cancelConfirm', 'cancelKeepButton', 'cancelYesButton', 'document', 'completeRequest', 'setTimeout', 'clearTimeout', block)(
    cancelButton, cancelConfirm, cancelKeepButton, cancelYesButton, document, completeRequest, clock.setTimeout, clock.clearTimeout);
  return { cancelButton, cancelConfirm, cancelKeepButton, cancelYesButton, actions, requests, clock };
}

test('pressing Cancel asks first and sends nothing', () => {
  const { cancelButton, cancelConfirm, cancelKeepButton, actions, requests } = setup();
  cancelButton.listeners.click();
  assert.equal(cancelConfirm.hidden, false);
  assert.equal(cancelButton.ariaExpanded, 'true');
  assert.ok(actions.classes.has('confirming'));
  assert.equal(cancelKeepButton.focused, true, 'focus lands on the safe choice');
  assert.deepEqual(requests, []);
});

test('Keep answering closes the question, sends nothing and returns focus to Cancel', () => {
  const { cancelButton, cancelConfirm, cancelKeepButton, actions, requests } = setup();
  cancelButton.listeners.click();
  cancelKeepButton.listeners.click();
  assert.equal(cancelConfirm.hidden, true);
  assert.equal(cancelButton.ariaExpanded, 'false');
  assert.ok(!actions.classes.has('confirming'));
  assert.equal(cancelButton.focused, true);
  assert.deepEqual(requests, []);
});

test('only Confirm cancel sends the cancel request', async () => {
  const { cancelButton, cancelYesButton, requests, clock } = setup();
  cancelButton.listeners.click();
  clock.elapse();
  await cancelYesButton.listeners.click();
  assert.deepEqual(requests, [['api/cancel', { method: 'POST' }, 'cancel', 'Cancelled. No answers were submitted.']]);
});

test('Confirm cancel sends nothing while the panel is closed', async () => {
  const { cancelYesButton, requests } = setup();
  await cancelYesButton.listeners.click();
  assert.deepEqual(requests, []);
});

test('Confirm cancel is disabled for 600 ms after the panel opens, and sends nothing until then', async () => {
  const { cancelButton, cancelYesButton, requests, clock } = setup();
  cancelButton.listeners.click();
  assert.equal(cancelYesButton.disabled, true);
  assert.equal(clock.timers[0].ms, 600);
  await cancelYesButton.listeners.click(); // even if a click got through a disabled button
  assert.deepEqual(requests, []);
  clock.elapse();
  assert.equal(cancelYesButton.disabled, false);
});

test('Keep answering before the delay ends leaves no timer that could enable Confirm later', () => {
  const { cancelButton, cancelKeepButton, cancelYesButton, clock } = setup();
  cancelButton.listeners.click();
  cancelKeepButton.listeners.click();
  clock.elapse();
  assert.equal(cancelYesButton.disabled, true);
});

test('Cmd/Ctrl+Enter does nothing while the cancel question is open', () => {
  assert.match(app, /if \(event\.key === 'Enter'\) \{\n\s+if \(!cancelConfirm\.hidden\) return;/);
});

test('the page has no native dialog, and the question is a labelled group that starts hidden', () => {
  assert.doesNotMatch(app, /\b(window\.)?(confirm|alert|prompt)\(/);
  assert.match(html, /<div id="cancel-confirm" class="cancel-confirm" role="group" aria-labelledby="cancel-confirm-title" hidden>/);
  assert.match(html, /Discard your answers\?[\s\S]*?id="cancel-confirm-yes"[^>]*>Confirm cancel<[\s\S]*?id="cancel-confirm-keep"[^>]*>Keep answering</);
  assert.match(html, /id="cancel"[^>]*aria-expanded="false" aria-controls="cancel-confirm"/);
  // Both buttons are type="button", so neither submits the form.
  assert.match(html, /<button type="button" id="cancel-confirm-keep"/);
  assert.match(html, /<button type="button" id="cancel-confirm-yes"/);
});

test('Escape and moving to another screen close the question; the form is never touched', () => {
  assert.match(app, /if \(event\.key === 'Escape'\) closeCancelConfirm\(true\);/);
  assert.match(app, /summary\.hidden = true;\n  closeCancelConfirm\(false\);\n  currentScreen = index;/);
  assert.doesNotMatch(block, /reset\(|\.value\s*=|form\.hidden/);
});

test('the question hides the other action buttons and stays usable on a phone', () => {
  assert.match(css, /\.actions\.confirming > :not\(\.cancel-confirm\) \{ display: none; \}/);
  assert.match(css, /\.cancel-confirm\[hidden\] \{ display: none; \}/);
  const narrowCss = [...css.matchAll(/@media \(max-width: 800px\) \{([\s\S]*?)\n\}\n/g)].map((m) => m[1]).join('\n');
  assert.match(narrowCss, /\.actions button \{ min-height: 48px; \}/);
  // Phone: Confirm cancel above, Keep answering last and full width, where Cancel was.
  assert.match(narrowCss, /\.cancel-confirm button \{ flex: 1 1 100%; \}/);
  assert.ok(html.indexOf('id="cancel-confirm-yes"') < html.indexOf('id="cancel-confirm-keep"'));
});
