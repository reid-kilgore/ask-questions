import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { lookupTmuxWindow, openBrowser, sessionUrlMessage } from '../bin/ask-questions.js';
import { validatePayload } from '../lib/contract.js';

const command = ['node', resolve('bin/ask-questions.js')];

// Strip tmux variables so spawned-CLI tests behave the same whether or not the test runner
// itself is inside tmux. Tests that exercise the tmux feature on purpose pass their own env.
function withoutTmux(env = process.env) {
  const { TMUX: _tmux, TMUX_PANE: _tmuxPane, ...rest } = env;
  return rest;
}

function startCli(args, input = '', cwd = process.cwd(), env = withoutTmux()) {
  const child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(input);
  return { child, closed, output: () => ({ stdout, stderr }) };
}

async function stopChild(session) {
  if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill('SIGTERM');
  const stopTimeout = new Promise((resolve) => setTimeout(resolve, 1_000));
  if (await Promise.race([session.closed.then(() => true, () => true), stopTimeout.then(() => false)])) return;
  session.child.kill('SIGKILL');
  await session.closed.catch(() => {});
}

async function waitForUrl(session) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = session.output().stderr.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for URL: ${session.output().stderr}`);
}

test('help is a self-sufficient agent contract', async () => {
  const session = startCli(['--help']);
  try {
    const close = await session.closed;
    const { stdout, stderr } = session.output();
    assert.equal(close.code, 0);
    assert.equal(stderr, '');
    for (const section of [
      'Input modes:',
      'Local installation for this proof of concept:',
      'npm install',
      'npm link',
      'laptop-local',
      'PATH utility',
      '--json and --file are mutually exclusive.',
      'stdin',
      'Question-writing guidance:',
      'Write questions in simple technical English.',
      'You can batch several related questions in one payload.',
      'A payload with one question is also valid.',
      'option descriptions, or a supporting Markdown document.',
      'Payload schema (version must be 1):',
      '"message": "optional non-empty Markdown string"',
      '"type": "single" | "multiple" | "text"',
      '"allowOther": true | false,                // optional; choice questions only; defaults to true. Set false to turn Other off.',
      'Single and multiple-choice questions show an Other free-text option by default.',
      'Set "allowOther": false on a question to turn it off.',
      '"placeholder": "optional string"',
      'exactly one of markdown or path',
      'Document ids are unique non-empty strings. Document titles are non-empty strings.',
      'Document paths are relative',
      'Lexical and symbolic-link checks',
      'keep paths in that base directory.',
      'The message and documents accept',
      'Unsafe link schemes are neutralized.',
      'stdout contains exactly one JSON value',
      '"answers":{"question-id":{"value":"...","notes":"..."}}',
      '"status":"cancelled","askerPath":"/absolute/path","answers":{}',
      'logs are written to stderr',
      'blocks until it receives Submit, Cancel, or Ctrl-C',
      'A human can take hours to answer.',
      'There is no built-in answer timeout.',
      'The command remains blocked until Submit, Cancel, or an interruption.',
      'Calling agents must disable their execution timeout or set it to several hours.',
      'Normal waiting is not a failure.',
      'Clipboard recovery:',
      'Copy as JSON',
      'not persistence or session',
      'recovery: it does not save answers',
      'Every submitted answer must include a notes string.',
      'field in the user interface is optional',
      'Exit codes:',
      '0 submitted; 2 cancelled or interrupted with Ctrl-C; 1 invalid input or server error.',
      '--no-open prevents that action for automation',
      '--ding             Keep the ready sound enabled.',
      '--no-ding          Do not play the ready sound.',
      'The ready sound is enabled by default.',
      'askerPath is always derived from the command current working directory.',
      'Payload JSON cannot set or override askerPath.',
      'Asked from',
      'Capture only the submitted JSON.',
      'Inline Markdown document:',
      'Relative-path Markdown document:',
      'Annotations:',
      'comment directly on the text they are reading',
      'CriticMarkup ({==highlight==}{>>comment<<}) markers',
      'Anchoring is block level',
      'annotations is always present in the result, alongside answers',
      'It never changes the shape of answers.',
      'The server, not the browser, is the authority on each block\'s plain text',
      'Annotating is always optional and never blocks Submit.',
      'is no highlight-only action.',
      'To comment, select text and press Cmd+E (Ctrl+E off macOS)',
      'the browser\'s own "search using',
      'selection" binding for that key is suppressed',
      'A quiet on-screen reminder of this appears on the page.',
      'existing mark reopens the same popup, pre-filled, to edit it',
      'a sibling checkout at ../criticmarkup',
      'A Comments button, top right of the main pane, opens a panel listing',
      'including any annotations, without submitting',
      '"id":"context","title":"Release context","markdown":"## Context',
      '"id":"release-notes","title":"Release notes","path":"examples/release-notes.md"',
      'Examples:',
    ]) assert.ok(stdout.includes(section), `Help is missing: ${section}`);
  } finally {
    await stopChild(session);
  }
});

test('help examples show valid batches and keep a multi-question request file', async () => {
  const help = await new Promise((resolveHelp, rejectHelp) => {
    const session = startCli(['--help']);
    session.closed.then(({ code }) => {
      if (code === 0) resolveHelp(session.output().stdout);
      else rejectHelp(new Error(session.output().stderr));
    }, rejectHelp);
  });
  const examples = help.slice(help.indexOf('\nExamples:\n'));
  const payloads = [...examples.matchAll(/(?:--json|printf '%s') '({.*})'/g)].map((match) => match[1]);
  assert.equal(payloads.length, 4, 'Examples must show four JSON payloads before they are validated.');
  for (const source of payloads) {
    const payload = JSON.parse(source);
    validatePayload(payload);
    assert.ok(payload.questions.length >= 2, 'Each displayed payload must show a question batch.');
  }
  const request = JSON.parse(await readFile('examples/request.json', 'utf8'));
  validatePayload(request);
  assert.ok(request.questions.length >= 2, 'examples/request.json must remain a multi-question example.');
});

test('help works through a symbolic command link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ask-questions-link-'));
  const linkedCommand = join(directory, 'ask-questions');
  await symlink(resolve('bin/ask-questions.js'), linkedCommand);
  const child = spawn(linkedCommand, ['--help'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const close = await new Promise((resolveClose, rejectClose) => {
      child.once('error', rejectClose);
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    });
    assert.equal(close.code, 0);
    assert.equal(stderr, '');
    assert.ok(stdout.length > 0, 'Linked command must write --help output.');
    assert.match(stdout, /Usage:/);
    assert.match(stdout, /Question-writing guidance:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('no-browser session submits a JSON result', async () => {
  const input = JSON.stringify({ version: 1, askerPath: '/untrusted/payload/value', questions: [{ id: 'go', prompt: 'Continue?', type: 'single', required: true, options: [{ value: 'yes', label: 'Yes' }] }] });
  const session = startCli(['--no-open', '--no-ding'], input);
  try {
    const url = await waitForUrl(session);
    const response = await fetch(`${url}api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ questionId: 'go', value: 'yes', notes: 'ok' }] }),
    });
    assert.equal(response.status, 200);
    const close = await session.closed;
    const result = JSON.parse(session.output().stdout);
    assert.equal(close.code, 0);
    assert.equal(result.version, 1);
    assert.equal(result.status, 'submitted');
    assert.equal(result.askerPath, process.cwd());
    assert.deepEqual(result.answers, { go: { value: 'yes', notes: 'ok' } });
    assert.equal(result.answers.go.questionId, undefined);
    assert.match(result.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await stopChild(session);
  }
});

test('no-browser session submits annotations alongside answers, anchored to the server\'s own block text', async () => {
  const input = JSON.stringify({
    version: 1,
    message: 'A **message** for context.',
    questions: [{ id: 'choice', prompt: 'Which risk needs attention?', type: 'single', options: [{ value: 'rollback', label: 'Rollback', description: 'Revert the release.' }] }],
    documents: [{ id: 'notes', title: 'Notes', markdown: 'Some supporting notes.' }],
  });
  const session = startCli(['--no-open', '--no-ding'], input);
  try {
    const url = await waitForUrl(session);
    const sessionData = await fetch(`${url}api/session`).then((response) => response.json());
    const messageBlockId = Object.keys(sessionData.messageBlockText)[0];
    const documentBlockId = Object.keys(sessionData.documents[0].blockText)[0];
    const response = await fetch(`${url}api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        answers: [{ questionId: 'choice', value: 'rollback', notes: '' }],
        annotations: {
          message: { [messageBlockId]: 'A {==message==}{>>says what?<<} for context.' },
          documents: { notes: { [documentBlockId]: 'Some {==supporting==} notes.' } },
          questions: { choice: { prompt: 'Which {==risk==} needs attention?', options: { rollback: '{==Revert==} the release.' } } },
        },
      }),
    });
    assert.equal(response.status, 200);
    const close = await session.closed;
    const result = JSON.parse(session.output().stdout);
    assert.equal(close.code, 0);
    assert.deepEqual(result.annotations, {
      message: { [messageBlockId]: 'A {==message==}{>>says what?<<} for context.' },
      documents: { notes: { [documentBlockId]: 'Some {==supporting==} notes.' } },
      questions: { choice: { prompt: 'Which {==risk==} needs attention?', options: { rollback: '{==Revert==} the release.' } } },
    });
  } finally {
    await stopChild(session);
  }
});

test('rejects a submitted annotation whose text was not the block\'s own original text', async () => {
  const input = JSON.stringify({ version: 1, message: 'A message.', questions: [{ id: 'go', prompt: 'Continue?', type: 'text' }] });
  const session = startCli(['--no-open', '--no-ding'], input);
  try {
    const url = await waitForUrl(session);
    const sessionData = await fetch(`${url}api/session`).then((response) => response.json());
    const messageBlockId = Object.keys(sessionData.messageBlockText)[0];
    const response = await fetch(`${url}api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        answers: [{ questionId: 'go', value: '', notes: '' }],
        annotations: { message: { [messageBlockId]: 'A rewritten {==message==}.' } },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.issues.some((issue) => issue.location === `annotations.message.${messageBlockId}`));
    await fetch(`${url}api/cancel`, { method: 'POST' });
    await session.closed;
  } finally {
    await stopChild(session);
  }
});

test('server output preserves a __proto__ question id', async () => {
  const input = JSON.stringify({ version: 1, questions: [{ id: '__proto__', prompt: 'Explain', type: 'text', required: true }] });
  const session = startCli(['--no-open', '--no-ding'], input);
  try {
    const url = await waitForUrl(session);
    const response = await fetch(`${url}api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ questionId: '__proto__', value: 'Answer', notes: 'Context' }] }),
    });
    assert.equal(response.status, 200);
    await session.closed;
    const result = JSON.parse(session.output().stdout);
    assert.equal(Object.hasOwn(result.answers, '__proto__'), true);
    assert.deepEqual(result.answers.__proto__, { value: 'Answer', notes: 'Context' });
  } finally {
    await stopChild(session);
  }
});

test('no-browser session cancels with an empty keyed answer object', async () => {
  const input = JSON.stringify({ version: 1, questions: [{ id: 'stop', prompt: 'Continue?', type: 'text' }] });
  const session = startCli(['--no-open', '--no-ding'], input);
  try {
    const url = await waitForUrl(session);
    const response = await fetch(`${url}api/cancel`, { method: 'POST' });
    assert.equal(response.status, 200);
    const close = await session.closed;
    assert.equal(close.code, 2);
    assert.deepEqual(JSON.parse(session.output().stdout), { version: 1, status: 'cancelled', askerPath: process.cwd(), answers: {}, annotations: {} });
  } finally {
    await stopChild(session);
  }
});

test('spawned session includes askerTmuxWindow when TMUX_PANE resolves to a window name', async () => {
  const binDirectory = await mkdtemp(join(tmpdir(), 'ask-questions-fake-tmux-'));
  const fakeTmux = join(binDirectory, 'tmux');
  await writeFile(fakeTmux, '#!/bin/sh\nprintf %s "review-work"\n');
  await chmod(fakeTmux, 0o755);
  const env = { ...withoutTmux(), TMUX_PANE: '%7', PATH: `${binDirectory}:${process.env.PATH}` };
  const input = JSON.stringify({ version: 1, questions: [{ id: 'stop', prompt: 'Continue?', type: 'text' }] });
  const session = startCli(['--no-open', '--no-ding'], input, process.cwd(), env);
  try {
    const url = await waitForUrl(session);
    const sessionData = await fetch(`${url}api/session`).then((response) => response.json());
    assert.equal(sessionData.askerTmuxWindow, 'review-work');
    await fetch(`${url}api/cancel`, { method: 'POST' });
    const close = await session.closed;
    assert.equal(close.code, 2);
    assert.deepEqual(JSON.parse(session.output().stdout), {
      version: 1,
      status: 'cancelled',
      askerPath: process.cwd(),
      askerTmuxWindow: 'review-work',
      answers: {},
      annotations: {},
    });
  } finally {
    await stopChild(session);
    await rm(binDirectory, { recursive: true, force: true });
  }
});

test('serves annotate.js and criticmarkup as importable ES modules, and criticmarkup is not copied into the repo', async () => {
  const input = JSON.stringify({ version: 1, questions: [{ id: 'stop', prompt: 'Continue?', type: 'text' }] });
  const session = startCli(['--no-open', '--no-ding'], input);
  try {
    const url = await waitForUrl(session);
    const [annotateResponse, criticmarkupResponse] = await Promise.all([
      fetch(`${url}annotate.js`),
      fetch(`${url}vendor/criticmarkup.js`),
    ]);
    assert.equal(annotateResponse.status, 200);
    assert.match(annotateResponse.headers.get('content-type'), /javascript/);
    assert.match(await annotateResponse.text(), /export function attachMessage/);
    assert.equal(criticmarkupResponse.status, 200);
    assert.match(criticmarkupResponse.headers.get('content-type'), /javascript/);
    assert.match(await criticmarkupResponse.text(), /export function insertAnnotation/);
    await fetch(`${url}api/cancel`, { method: 'POST' });
    await session.closed;
  } finally {
    await stopChild(session);
  }
});

test('session shows the derived caller path and ignores a payload path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ask-questions-asker-'));
  const expectedAskerPath = await realpath(directory);
  const input = JSON.stringify({ version: 1, askerPath: '/payload/path', questions: [{ id: 'stop', prompt: 'Continue?', type: 'text' }] });
  const session = startCli(['--no-open', '--no-ding'], input, directory);
  try {
    const url = await waitForUrl(session);
    const sessionData = await fetch(`${url}api/session`).then((response) => response.json());
    assert.equal(sessionData.askerPath, expectedAskerPath);
    assert.notEqual(sessionData.askerPath, '/payload/path');
    await fetch(`${url}api/cancel`, { method: 'POST' });
    await session.closed;
    assert.equal(JSON.parse(session.output().stdout).askerPath, expectedAskerPath);
  } finally {
    await stopChild(session);
    await rm(directory, { recursive: true, force: true });
  }
});

test('session renders a Markdown message with the document safety rules', async () => {
  const message = '# Context\n\n- First item\n- Second item\n\n*emphasis* and `code`\n\n[Safe link](https://example.com)\n\n<script>alert(1)</script>\n\n[Unsafe link](javascript:alert(1))';
  const input = JSON.stringify({ version: 1, message, questions: [{ id: 'stop', prompt: 'Continue?', type: 'text' }] });
  const session = startCli(['--no-open', '--no-ding'], input);
  try {
    const url = await waitForUrl(session);
    const sessionData = await fetch(`${url}api/session`).then((response) => response.json());
    assert.match(sessionData.messageHtml, /<h1 data-block="[^"]+">Context<\/h1>/);
    assert.match(sessionData.messageHtml, /<ul data-block="[^"]+">/);
    assert.match(sessionData.messageHtml, /<em>emphasis<\/em>/);
    assert.match(sessionData.messageHtml, /<code>code<\/code>/);
    assert.match(sessionData.messageHtml, /href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer"/);
    assert.doesNotMatch(sessionData.messageHtml, /<script/i);
    assert.doesNotMatch(sessionData.messageHtml, /href="javascript:/i);
    assert.equal(sessionData.messageBlockText['0-1'], 'Context');
    await fetch(`${url}api/cancel`, { method: 'POST' });
    await session.closed;
  } finally {
    await stopChild(session);
  }
});

test('ding flags do not affect help output', async () => {
  for (const args of [['--help', '--ding'], ['--help', '--no-ding'], ['--help', '--ding', '--no-ding']]) {
    const session = startCli(args);
    try {
      const close = await session.closed;
      assert.equal(close.code, 0);
      assert.equal(session.output().stderr, '');
      assert.match(session.output().stdout, /--no-ding/);
    } finally {
      await stopChild(session);
    }
  }
});

test('ready sound starts only after the session URL is ready', async () => {
  const source = await readFile('bin/ask-questions.js', 'utf8');
  const urlIndex = source.indexOf('process.stderr.write(sessionUrlMessage(url));');
  const dingIndex = source.indexOf('if (ding) playReadySound();');
  assert.ok(urlIndex >= 0);
  assert.ok(dingIndex > urlIndex);
  assert.match(source, /spawn\('\/usr\/bin\/afplay', \['\/System\/Library\/Sounds\/Glass\.aiff'\]/);
  assert.match(source, /process\.stderr\.write\('\\x07'\)/);
});

test('document tabs do not make a second vertical scroll area', async () => {
  const style = await readFile('web/style.css', 'utf8');
  const documentList = style.match(/\.document-list \{([^}]*)\}/);
  assert.ok(documentList);
  assert.match(documentList[1], /flex: 0 0 auto/);
  assert.doesNotMatch(documentList[1], /max-height/);
  assert.doesNotMatch(documentList[1], /overflow-y/);
  assert.match(style, /\.document-content \{[^}]*overflow-y: auto/);
  assert.match(style, /@media \(max-width: 800px\)[\s\S]*\.document-content \{ max-height: 55vh; \}/);
});

test('gets a tmux window name without requiring a real tmux server', async () => {
  let call;
  const windowName = await lookupTmuxWindow({
    env: { TMUX_PANE: '%7' },
    execFileFn: (file, args, options, callback) => {
      call = { file, args, options };
      callback(null, 'review-work\n', '');
    },
  });
  assert.equal(windowName, 'review-work');
  assert.deepEqual(call.args, ['display-message', '-p', '-t', '%7', '#W']);
  assert.ok(call.options.timeout <= 250);
});

test('silently ignores unavailable tmux information', async () => {
  const windowName = await lookupTmuxWindow({
    env: { TMUX_PANE: '%missing' },
    execFileFn: (_file, _args, _options, callback) => callback(new Error('no server'), '', ''),
  });
  assert.equal(windowName, undefined);
});

function fakeOpener() {
  const child = new EventEmitter();
  child.unref = () => {};
  const calls = [];
  const messages = [];
  return {
    child,
    calls,
    messages,
    spawnFn: (file, args, options) => { calls.push({ file, args, options }); return child; },
    write: (text) => { messages.push(text); },
  };
}

test('reports a browser opener that exits with a non-zero code', () => {
  const opener = fakeOpener();
  openBrowser('http://127.0.0.1:1234/token/', { platform: 'darwin', env: {}, spawnFn: opener.spawnFn, write: opener.write });
  assert.deepEqual(opener.calls[0].args, ['http://127.0.0.1:1234/token/']);
  assert.equal(opener.calls[0].file, 'open');
  assert.deepEqual(opener.messages, []);
  opener.child.emit('exit', 1, null);
  assert.equal(opener.messages.length, 1);
  assert.match(opener.messages[0], /Could not open a browser automatically \(open exited with code 1\)/);
  assert.match(opener.messages[0], /Open the URL above/);
});

test('stays silent when the browser opener succeeds', () => {
  const opener = fakeOpener();
  openBrowser('http://127.0.0.1:1234/token/', { platform: 'darwin', env: { TMUX: '/tmp/tmux-501/default,1,0' }, spawnFn: opener.spawnFn, write: opener.write });
  opener.child.emit('exit', 0, null);
  assert.deepEqual(opener.messages, []);
});

test('adds a tmux hint when a browser launch fails inside tmux', () => {
  const opener = fakeOpener();
  openBrowser('http://127.0.0.1:1234/token/', { platform: 'darwin', env: { TMUX: '/tmp/tmux-501/default,1,0' }, spawnFn: opener.spawnFn, write: opener.write });
  opener.child.emit('exit', 1, null);
  assert.equal(opener.messages.length, 2);
  assert.match(opener.messages[1], /inside tmux/);
  assert.match(opener.messages[1], /graphical session that no longer exists/);
  assert.match(opener.messages[1], /Restart the tmux server/);
});

test('reports a browser opener that cannot start, and warns only once', () => {
  const opener = fakeOpener();
  openBrowser('http://127.0.0.1:1234/token/', { platform: 'linux', env: {}, spawnFn: opener.spawnFn, write: opener.write });
  assert.equal(opener.calls[0].file, 'xdg-open');
  opener.child.emit('error', new Error('spawn xdg-open ENOENT'));
  opener.child.emit('exit', 1, null);
  assert.equal(opener.messages.length, 1);
  assert.match(opener.messages[0], /spawn xdg-open ENOENT/);
});

test('reports a browser opener that a signal stopped', () => {
  const opener = fakeOpener();
  openBrowser('http://127.0.0.1:1234/token/', { platform: 'darwin', env: {}, spawnFn: opener.spawnFn, write: opener.write });
  opener.child.emit('exit', null, 'SIGTERM');
  assert.match(opener.messages[0], /open stopped with signal SIGTERM/);
});

const HYPERLINK_START = '\u001b]8;;';
const HYPERLINK_END = '\u001b\\';

test('writes the session URL as a plain line when stderr is not a terminal', () => {
  const url = 'http://127.0.0.1:1234/abc/';
  const message = sessionUrlMessage(url, { isTty: false });
  assert.equal(message, `ask-questions: ${url}\n`);
  assert.ok(!message.includes('\u001b'), 'Captured logs must stay free of escape sequences.');
});

test('writes the session URL as an OSC 8 hyperlink when stderr is a terminal', () => {
  const url = 'http://127.0.0.1:1234/abc/';
  const message = sessionUrlMessage(url, { isTty: true });
  const expected = `ask-questions: ${HYPERLINK_START}${url}${HYPERLINK_END}${url}${HYPERLINK_START}${HYPERLINK_END}\n`;
  assert.equal(message, expected);
  assert.ok(message.includes(url), 'The URL must stay readable as text.');
  assert.ok(message.endsWith('\n'));
});

test('interface source keeps focus actions, safe review rendering, and Other input rules', async () => {
  const [index, app, style] = await Promise.all([
    readFile('web/index.html', 'utf8'),
    readFile('web/app.js', 'utf8'),
    readFile('web/style.css', 'utf8'),
  ]);
  assert.match(index, /id="previous-question"/);
  assert.match(index, /id="next-question"/);
  assert.match(index, /id="review-summary"/);
  assert.match(index, /<button type="button" id="copy-json"/);
  assert.match(app, /let focused = true;/, 'Focus mode must be the initial view.');
  assert.match(app, /previousQuestion\.hidden = !focused/);
  assert.match(app, /nextQuestion\.hidden = !focused \|\| reviewing/);
  assert.match(app, /reviewSummary\.replaceChildren\(\)/);
  assert.match(app, /reviewSummary\.append\(item\)/);
  assert.doesNotMatch(app, /reviewSummary\.innerHTML/);
  assert.match(app, /value\.hidden = !selected/);
  assert.match(app, /if \(!selected\) value\.value = ''/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /const previousActiveElement = document\.activeElement/);
  assert.match(app, /try \{[\s\S]*document\.execCommand\('copy'\)[\s\S]*\} finally \{/);
  assert.match(app, /temporaryInput\.remove\(\)/);
  assert.match(app, /previousActiveElement\.focus\(\)/);
  assert.match(app, /copyJsonButton\.focus\(\)/);
  assert.match(app, /function buildCopiedResult\(answers\)/);
  assert.match(app, /status: 'submitted'/);
  assert.match(app, /submittedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(app, /Object\.fromEntries\(answers\.map/);
  assert.match(app, /return typeof value !== 'string' \|\| value\.trim\(\) === ''/);
  assert.match(app, /Copied JSON/);
  assert.match(app, /Could not copy JSON/);
  assert.match(app, /copyJsonButton\.hidden = !reviewing/);
  assert.match(style, /@media \(max-width: 1000px\)[\s\S]*\.actions #copy-json \{ grid-column: 2; grid-row: 1; \}/);
  assert.match(index, /id="shortcut-hint"/);
  assert.match(index, /id="asker-path"/);
  assert.match(app, /askerPath/);
  assert.match(app, /textContent = session\.askerPath/);
  assert.match(app, /attachMessage\(message, session\.messageHtml, session\.messageBlockText\)/);
  assert.match(app, /copy/);
  assert.match(app, /event\.repeat/);
  assert.match(app, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(app, /if \(reviewing\) form\.requestSubmit\(\)/);
  assert.match(app, /else nextQuestion\.click\(\)/);
  const nextHandler = app.match(/nextQuestion\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(nextHandler);
  assert.doesNotMatch(nextHandler[1], /incompleteRequiredQuestions/);
  assert.match(app, /focusedQuestionIndex = session\.questions\.indexOf\(missingQuestions\[0\]\)/);
});
