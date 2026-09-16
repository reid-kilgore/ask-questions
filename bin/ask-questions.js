#!/usr/bin/env node
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import MarkdownIt from 'markdown-it';
import { ContractError, parseArguments, resolveDocumentPath, validateAnnotations, validateAnswers, validatePayload } from '../lib/contract.js';
import { installBlockAnchors } from '../lib/blockAnchor.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const criticmarkupPath = resolve(root, 'node_modules/criticmarkup/src/index.js');
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options));
installBlockAnchors(markdown);

function isSafeMarkdownLink(href) {
  try {
    const parsed = new URL(href, 'http://localhost');
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const token = tokens[index];
  const href = token.attrGet('href');
  if (!href || !isSafeMarkdownLink(href)) token.attrSet('href', '#');
  else if (/^(?:https?:)?\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, index, options, environment, self);
};

export const HELP = `ask-questions — show a local blocking question form and return JSON

Usage:
  ask-questions --json '{"version":1,"questions":[...]}' [--no-open] [--ding|--no-ding]
  ask-questions --file request.json [--no-open] [--ding|--no-ding]
  printf '%s' '{"version":1,"questions":[...]}' | ask-questions [--no-open] [--ding|--no-ding]

Local installation for this proof of concept:
  npm install
  npm link
  Use npm link as the primary installation method. It makes this checkout a laptop-local
  PATH utility. It does not publish a package.
  npm install needs a sibling checkout at ../criticmarkup (relative to this repository) --
  a small zero-dependency library this project also uses, cloned separately because it is
  not a published package either. Clone both repositories side by side before npm install.

Input modes:
  --json JSON       Read an inline JSON payload.
  --file PATH       Read a JSON payload from PATH.
  stdin             When neither --json nor --file is given, read JSON from standard input.
  --json and --file are mutually exclusive. --help does not read input.

Options:
  --no-open          Do not open a browser automatically.
  --ding             Keep the ready sound enabled.
  --no-ding          Do not play the ready sound.
  The ready sound is enabled by default. When both sound options occur, the last option wins.

Question-writing guidance:
  Write questions in simple technical English. Include all relevant context in the question,
  option descriptions, or a supporting Markdown document.
  You can batch several related questions in one payload. A payload with one question is also valid.
  Single and multiple-choice questions show an Other free-text option by default. There is no need
  to ask for it. Set "allowOther": false on a question to turn it off.

Payload schema (version must be 1):
  {
    "version": 1,
    "title": "optional non-empty string",
    "message": "optional non-empty Markdown string",
    "questions": [
      {
        "id": "unique non-empty string",
        "prompt": "non-empty string",
        "type": "single" | "multiple" | "text" | "quiz",
        "required": true | false,                 // optional, defaults to false
        "options": [{                              // required for single, multiple, and quiz
          "value": "unique non-empty string",
          "label": "non-empty string",
          "description": "optional string"
        }],
        "allowOther": true | false,                // optional; single/multiple only; defaults to true. Set false to turn Other off. Invalid on quiz.
        "placeholder": "optional string",         // optional; text and Other inputs
        "answer": "option value",                 // quiz only; required; must equal one of this question's option values
        "why": "optional string",                 // quiz only; shown after the person answers
        "cite": "optional string",                // quiz only; shown after the person answers, as the spec sentence the answer rests on
        "allowDisagree": true | false             // quiz only; optional, defaults to true; shows an "I disagree with the spec here" toggle
      }
    ],
    "documents": [{                                // optional
      "id": "unique non-empty string",
      "title": "non-empty string",
      "markdown": "Markdown text"                 // exactly one of markdown or path
      // OR: "path": "relative/path/to/file.md"
    }]
  }

Document rules:
  Document ids are unique non-empty strings. Document titles are non-empty strings. Each document
  has exactly one of markdown or path. Document paths are relative to the payload file directory
  for --file, and to the current directory for --json or stdin. Lexical and symbolic-link checks
  keep paths in that base directory. Files are read into memory before the server starts; the
  server never serves arbitrary files. The message and documents accept Markdown. Markdown raw
  HTML is disabled. Unsafe link schemes are neutralized.

Lifecycle and output:
  A private server binds to 127.0.0.1 on a selected port. Its random session-token URL and
  logs are written to stderr. Only one browser session can submit or cancel. The command
  blocks until it receives Submit, Cancel, or Ctrl-C. A human can take hours to answer.
  There is no built-in answer timeout.
  The command remains blocked until Submit, Cancel, or an interruption.
  Calling agents must disable their execution timeout or set it to several hours.
  Normal waiting is not a failure. After HTTP 200, the page shows a clear
  submitted or cancelled state and tries to close its tab. stdout contains exactly one JSON value:
  submitted: {"version":1,"status":"submitted","askerPath":"/absolute/path","answers":{"question-id":{"value":"...","notes":"..."}},"annotations":{...},"submittedAt":"ISO-8601"}
  cancelled: {"version":1,"status":"cancelled","askerPath":"/absolute/path","answers":{},"annotations":{}}
  Multiple-choice values are arrays of strings. Single-choice and text values are normal
  values (a single optional choice can be null). Submitted answers are keyed by question id and
  contain value and notes only. Every submitted answer must include a notes string. The Notes
  field in the user interface is optional and sends an empty string when blank.
  Quiz questions are the one exception: their answer entry is
  {"value":"...","notes":"...","correct":true|false,"answer":"...","disagree":true|false} --
  value is the chosen option's value (or null), correct compares it to the question's own
  answer, answer echoes the question's answer so the caller does not need to re-read the
  original payload, and disagree reports whether the person flagged the spec's answer as
  wrong (their disagree note is carried in notes). When the payload has at least one quiz
  question, the submitted result also carries a top-level score field:
  "score":{"right":N,"wrong":N,"disagree":N,"total":N} -- right/wrong partition all quiz
  questions on correct, disagree counts quiz answers with disagree:true regardless of
  correctness, and total is the number of quiz questions in the payload. A payload with no
  quiz questions never gets a score field.
  askerPath is always derived from the command current working directory. Payload JSON cannot set or override askerPath.
  The page shows it as Asked from. When the command starts in tmux, it also
  makes a best-effort, short lookup of the current tmux window name. If found, askerTmuxWindow is
  shown near Asked from and included as an optional top-level result field.

Annotations:
  The person answering can comment directly on the text they are reading -- not only answer the
  questions. Three surfaces are annotatable: supporting documents, the introductory message, and
  question prompts together with their option descriptions. Anchoring is block level: a paragraph,
  heading, list item, or code block is the smallest unit that can be marked up, not an arbitrary
  character range within one. A comment always has both a highlight and text explaining it; there
  is no highlight-only action. Annotating is always optional and never blocks Submit.
  To comment, select text and press Cmd+E (Ctrl+E off macOS) -- the browser's own "search using
  selection" binding for that key is suppressed on this page so it can be reused. With no
  selection, the same shortcut on a focused block, prompt, or option description comments on the
  whole thing; that is also the keyboard path, since these elements are not text inputs a keyboard
  user could start a selection inside. A quiet on-screen reminder of this appears on the page.
  Cmd/Ctrl+Enter in the popup saves the comment and Escape cancels; both take precedence over the
  same shortcuts used elsewhere in the form while the comment field has focus, and Cmd/Ctrl+E
  itself does nothing while typing in the comment field or an ordinary answer field. Clicking an
  existing mark reopens the same popup, pre-filled, to edit it; Delete/Backspace removes it while
  a mark has keyboard focus. A Comments button, top right of the main pane, opens a panel listing
  every comment made so far, with its own count, where a comment can be jumped to, edited, or
  removed, wherever in the form it lives.
  annotations is always present in the result, alongside answers, and defaults to {} when nothing
  was marked up or the request was cancelled. It never changes the shape of answers.
  Every leaf value is the block's, prompt's, or option description's own plain text with
  CriticMarkup ({==highlight==}{>>comment<<}) markers spliced in around each annotated range, so a
  comment always arrives together with the exact text it applies to:
  {"message":{"2-3":"a rewritten sentence would be {==clearer==}{>>say why<<}"},
   "documents":{"doc-id":{"0-1":"{==the risky part==}{>>needs a runbook link<<}"}},
   "questions":{"question-id":{"prompt":"{==which..?==}{>>ambiguous<<}"}}}
  message and documents keys are the source Markdown line range the annotated block came from
  (e.g. "2-3"); this is the caller's own document, so that range is directly usable against it.
  question/option keys are the question id and option value, since prompts and option descriptions
  never pass through a Markdown renderer and have no line range.
  The server, not the browser, is the authority on each block's plain text: a submitted annotation
  is rejected (the same 400 a malformed answer gets) unless stripping its CriticMarkup markers
  reproduces that text exactly.

Clipboard recovery:
  The final review screen has Copy as JSON. It copies the submitted-result JSON that the command
  would print, including any annotations, without submitting or sending a network request. It can
  help when a calling agent timed out, as long as the already-loaded page remains open.
  It is not persistence or session recovery: it does not save answers, restart a stopped command,
  or restore a closed page.

Exit codes:
  0 submitted; 2 cancelled or interrupted with Ctrl-C; 1 invalid input or server error.

Browser behavior:
  The command opens the URL with macOS open, xdg-open, or Windows start when available.
  --no-open prevents that action for automation; the URL is still printed to stderr.
  When the opener cannot start, or when it exits with a non-zero code or a signal, the command
  writes one warning to stderr and keeps waiting. Open the URL manually in that case.
  Inside tmux the warning adds a hint: a tmux server that has run for a long time can stay
  attached to a graphical session that no longer exists, which makes every browser launch fail.
  Restarting the tmux server from a terminal window repairs it.
  When stderr is a terminal, the session URL is also written as an OSC 8 hyperlink, so a
  terminal that supports hyperlinks can open it directly. The terminal, not this command,
  opens the page, so this route still works when the opener fails. A redirected or piped
  stderr receives the plain URL with no escape sequences.
  The ready sound is enabled by default. It plays after the page is ready, works with --no-open,
  and never writes sound data or status to stdout. Use --no-ding to disable it.

Examples:
  # Read a multi-question request file.
  ask-questions --file examples/request.json

  # Send an inline batch with text and single-choice questions.
  ask-questions --json '{"version":1,"message":"## Context\\n\\nInclude **relevant details** here.","questions":[{"id":"summary","prompt":"What is the main concern?","type":"text"},{"id":"priority","prompt":"What priority should this have?","type":"single","options":[{"value":"high","label":"High"},{"value":"normal","label":"Normal"}]}]}'

  # Inline Markdown document: the document text is in the related-question batch.
  ask-questions --json '{"version":1,"questions":[{"id":"decision","prompt":"Should we ship this release?","type":"single","required":true,"options":[{"value":"ship","label":"Ship"},{"value":"hold","label":"Hold"}]},{"id":"reason","prompt":"What should the release note say?","type":"text"}],"documents":[{"id":"context","title":"Release context","markdown":"## Context\\n\\nThe tests passed."}]}'

  # Relative-path Markdown document: run this from the project directory. The path base is the current directory.
  ask-questions --json '{"version":1,"questions":[{"id":"read","prompt":"Did you read the release notes?","type":"single","required":true,"options":[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]},{"id":"risks","prompt":"Which risks need attention?","type":"multiple","options":[{"value":"support","label":"Support"},{"value":"rollback","label":"Rollback"}]}],"documents":[{"id":"release-notes","title":"Release notes","path":"examples/release-notes.md"}]}'

  # Send a related-question batch through standard input without opening a browser.
  printf '%s' '{"version":1,"questions":[{"id":"note","prompt":"What should the agent know?","type":"text"},{"id":"ready","prompt":"Is the work ready to continue?","type":"single","options":[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]}]}' | ask-questions --no-open

  # Disable the default ready sound.
  ask-questions --file examples/request.json --no-ding

  # Capture only the submitted JSON. The session URL remains on stderr.
  result="$(ask-questions --file examples/request.json --no-open)"
  printf '%s\\n' "$result"
`;

function reportError(error) {
  process.stderr.write(`ask-questions: ${error.message}\n`);
  for (const item of error.issues ?? []) process.stderr.write(`  ${item.location}: ${item.message}\n`);
}

async function readPayload(args) {
  let source;
  let baseDirectory = process.cwd();
  if (args.json !== undefined) source = args.json;
  else if (args.file !== undefined) {
    const filePath = resolve(process.cwd(), args.file);
    source = await readFile(filePath, 'utf8');
    baseDirectory = dirname(filePath);
  } else {
    source = await new Promise((resolveInput, rejectInput) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { value += chunk; });
      process.stdin.on('end', () => resolveInput(value));
      process.stdin.on('error', rejectInput);
    });
  }
  let payload;
  try { payload = JSON.parse(source); } catch { throw new ContractError('Input is not valid JSON.'); }
  validatePayload(payload);
  // `env.blockText` (populated by installBlockAnchors) is this block's own
  // plain text — the single authority the browser's annotation offsets and
  // the server's later validation both anchor to. It travels to the page
  // alongside `html` so the browser never has to reconstruct it itself.
  const renderMarkdown = (source) => {
    const env = {};
    const html = markdown.render(source, env);
    return { html, blockText: env.blockText };
  };
  const documents = await Promise.all((payload.documents ?? []).map(async (document) => {
    if (document.markdown !== undefined) return { id: document.id, title: document.title, ...renderMarkdown(document.markdown) };
    const documentPath = await resolveDocumentPath(baseDirectory, document.path);
    let sourceMarkdown;
    try { sourceMarkdown = await readFile(documentPath, 'utf8'); } catch (error) { throw new ContractError(`Cannot read document ${document.path}: ${error.message}`); }
    return { id: document.id, title: document.title, ...renderMarkdown(sourceMarkdown) };
  }));
  const message = payload.message ? renderMarkdown(payload.message) : undefined;
  const anchors = {
    message: message?.blockText ?? null,
    documents: Object.fromEntries(documents.map((document) => [document.id, document.blockText])),
  };
  return { payload, documents, messageHtml: message?.html, messageBlockText: message?.blockText, anchors };
}

function send(response, status, contentType, body) {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

async function requestBody(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 1_000_000) throw new ContractError('Request body is too large.');
  }
  try { return JSON.parse(data); } catch { throw new ContractError('Request body is not valid JSON.'); }
}

async function staticFile(name) {
  return readFile(resolve(root, 'web', name));
}

export function openBrowser(url, { platform = process.platform, env = process.env, spawnFn = spawn, write = (text) => process.stderr.write(text) } = {}) {
  const command = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const failed = (reason) => {
    write(`ask-questions: Could not open a browser automatically (${reason}). Open the URL above.\n`);
    if (env.TMUX) {
      write('ask-questions: This command is running inside tmux. A tmux server that has run for a long time can stay attached to a graphical session that no longer exists. Every browser launch from it then fails. Restart the tmux server from a terminal window to repair this.\n');
    }
  };
  const child = spawnFn(command[0], command[1], { detached: true, stdio: 'ignore' });
  let reported = false;
  const reportOnce = (reason) => { if (!reported) { reported = true; failed(reason); } };
  child.on('error', (error) => reportOnce(error.message));
  child.on('exit', (code, signal) => {
    if (signal) reportOnce(`${command[0]} stopped with signal ${signal}`);
    else if (code !== 0) reportOnce(`${command[0]} exited with code ${code}`);
  });
  child.unref();
  return child;
}

function playReadySound() {
  if (process.platform !== 'darwin') {
    process.stderr.write('\x07');
    return;
  }
  try {
    const child = spawn('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], { detached: true, stdio: 'ignore' });
    child.once('error', () => process.stderr.write('\x07'));
    child.unref();
  } catch {
    process.stderr.write('\x07');
  }
}

export function lookupTmuxWindow({ env = process.env, execFileFn = execFile } = {}) {
  const pane = env.TMUX_PANE;
  if (!pane) return Promise.resolve(undefined);
  return new Promise((resolveWindow) => {
    try {
      execFileFn('tmux', ['display-message', '-p', '-t', pane, '#W'], { timeout: 250 }, (error, stdout) => {
        const windowName = error ? '' : String(stdout).trim();
        resolveWindow(windowName || undefined);
      });
    } catch {
      resolveWindow(undefined);
    }
  });
}

// OSC 8 turns the session URL into a terminal hyperlink. tmux 3.4 and later forward it
// without passthrough. A redirected stderr gets plain text so captured logs stay clean.
const hyperlinkStart = '\u001b]8;;';
const hyperlinkEnd = '\u001b\\';

export function sessionUrlMessage(url, { isTty = process.stderr.isTTY } = {}) {
  if (!isTty) return `ask-questions: ${url}\n`;
  return `ask-questions: ${hyperlinkStart}${url}${hyperlinkEnd}${url}${hyperlinkStart}${hyperlinkEnd}\n`;
}

function askerMetadata(askerPath, askerTmuxWindow) {
  return { askerPath, ...(askerTmuxWindow ? { askerTmuxWindow } : {}) };
}

async function serve(payload, documents, messageHtml, messageBlockText, anchors, { noOpen, ding, askerPath, askerTmuxWindow }) {
  const metadata = askerMetadata(askerPath, askerTmuxWindow);
  const token = randomBytes(24).toString('hex');
  const index = await staticFile('index.html');
  const app = await staticFile('app.js');
  const annotate = await staticFile('annotate.js');
  const style = await staticFile('style.css');
  const criticmarkup = await readFile(criticmarkupPath);
  let complete;
  const finished = new Promise((resolveFinished) => { complete = resolveFinished; });
  let done = false;
  const completeOnce = (result) => { if (!done) { done = true; complete(result); } };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const prefix = `/${token}`;
    try {
      if (!pathname.startsWith(prefix)) return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
      const suffix = pathname.slice(prefix.length) || '/';
      if (request.method === 'GET' && suffix === '/') return send(response, 200, 'text/html; charset=utf-8', index);
      if (request.method === 'GET' && suffix === '/app.js') return send(response, 200, 'application/javascript; charset=utf-8', app);
      if (request.method === 'GET' && suffix === '/annotate.js') return send(response, 200, 'application/javascript; charset=utf-8', annotate);
      if (request.method === 'GET' && suffix === '/style.css') return send(response, 200, 'text/css; charset=utf-8', style);
      // The browser has no bundler and no client-side dependencies of its
      // own; criticmarkup is zero-dependency plain ESM, so it is served
      // verbatim from node_modules rather than copied into this repo.
      if (request.method === 'GET' && suffix === '/vendor/criticmarkup.js') return send(response, 200, 'application/javascript; charset=utf-8', criticmarkup);
      if (request.method === 'GET' && suffix === '/api/session') return send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ title: payload.title, messageHtml, messageBlockText, questions: payload.questions, documents, ...metadata }));
      if (request.method === 'POST' && suffix === '/api/submit') {
        const body = await requestBody(request);
        const answers = validateAnswers(payload, body.answers);
        const annotations = validateAnnotations(payload, anchors, body.annotations);
        const quizAnswers = payload.questions
          .filter((question) => question.type === 'quiz')
          .map((question) => answers[question.id]);
        const score = quizAnswers.length
          ? {
            right: quizAnswers.filter((answer) => answer.correct).length,
            wrong: quizAnswers.filter((answer) => !answer.correct).length,
            disagree: quizAnswers.filter((answer) => answer.disagree).length,
            total: quizAnswers.length,
          }
          : undefined;
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
        completeOnce({ version: 1, status: 'submitted', ...metadata, answers, annotations, ...(score ? { score } : {}), submittedAt: new Date().toISOString() });
        return;
      }
      if (request.method === 'POST' && suffix === '/api/cancel') {
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
        completeOnce({ version: 1, status: 'cancelled', ...metadata, answers: {}, annotations: {} });
        return;
      }
      return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error) {
      const status = error instanceof ContractError ? 400 : 500;
      send(response, status, 'application/json; charset=utf-8', JSON.stringify({ error: error.message, issues: error.issues ?? [] }));
    }
  });
  await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/${token}/`;
  process.stderr.write(sessionUrlMessage(url));
  if (ding) playReadySound();
  if (!noOpen) openBrowser(url);
  const interrupt = () => completeOnce({ version: 1, status: 'cancelled', ...metadata, answers: {}, annotations: {} });
  process.once('SIGINT', interrupt);
  const result = await finished;
  process.removeListener('SIGINT', interrupt);
  await new Promise((resolveClose) => server.close(resolveClose));
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArguments(argv);
    if (args.help) { process.stdout.write(HELP); return 0; }
    const askerPath = process.cwd();
    const askerTmuxWindow = await lookupTmuxWindow();
    const { payload, documents, messageHtml, messageBlockText, anchors } = await readPayload(args);
    const result = await serve(payload, documents, messageHtml, messageBlockText, anchors, { ...args, askerPath, askerTmuxWindow });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'submitted' ? 0 : 2;
  } catch (error) {
    reportError(error);
    return 1;
  }
}

function isDirectEntryPoint() {
  try {
    return process.argv[1] !== undefined
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntryPoint()) main().then((code) => { process.exitCode = code; });
