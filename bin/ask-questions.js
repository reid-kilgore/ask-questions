#!/usr/bin/env node
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import MarkdownIt from 'markdown-it';
import { ContractError, parseArguments, resolveDocumentPath, validateAnswers, validatePayload } from '../lib/contract.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options));

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
        "type": "single" | "multiple" | "text",
        "required": true | false,                 // optional, defaults to false
        "options": [{                              // required for single and multiple only
          "value": "unique non-empty string",
          "label": "non-empty string",
          "description": "optional string"
        }],
        "allowOther": true | false,                // optional; choice questions only; defaults to true. Set false to turn Other off.
        "placeholder": "optional string"          // optional; text and Other inputs
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
  submitted: {"version":1,"status":"submitted","askerPath":"/absolute/path","answers":{"question-id":{"value":"...","notes":"..."}},"submittedAt":"ISO-8601"}
  cancelled: {"version":1,"status":"cancelled","askerPath":"/absolute/path","answers":{}}
  Multiple-choice values are arrays of strings. Single-choice and text values are normal
  values (a single optional choice can be null). Submitted answers are keyed by question id and
  contain value and notes only. Every submitted answer must include a notes string. The Notes
  field in the user interface is optional and sends an empty string when blank.
  askerPath is always derived from the command current working directory. Payload JSON cannot set or override askerPath.
  The page shows it as Asked from. When the command starts in tmux, it also
  makes a best-effort, short lookup of the current tmux window name. If found, askerTmuxWindow is
  shown near Asked from and included as an optional top-level result field.

Clipboard recovery:
  The final review screen has Copy as JSON. It copies the submitted-result JSON that the command
  would print, without submitting or sending a network request. It can help when a calling agent
  timed out, as long as the already-loaded page remains open. It is not persistence or session
  recovery: it does not save answers, restart a stopped command, or restore a closed page.

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
  const documents = await Promise.all((payload.documents ?? []).map(async (document) => {
    if (document.markdown !== undefined) return { id: document.id, title: document.title, html: markdown.render(document.markdown) };
    const documentPath = await resolveDocumentPath(baseDirectory, document.path);
    let sourceMarkdown;
    try { sourceMarkdown = await readFile(documentPath, 'utf8'); } catch (error) { throw new ContractError(`Cannot read document ${document.path}: ${error.message}`); }
    return { id: document.id, title: document.title, html: markdown.render(sourceMarkdown) };
  }));
  return { payload, documents, messageHtml: payload.message ? markdown.render(payload.message) : undefined };
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

async function serve(payload, documents, messageHtml, { noOpen, ding, askerPath, askerTmuxWindow }) {
  const metadata = askerMetadata(askerPath, askerTmuxWindow);
  const token = randomBytes(24).toString('hex');
  const index = await staticFile('index.html');
  const app = await staticFile('app.js');
  const style = await staticFile('style.css');
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
      if (request.method === 'GET' && suffix === '/style.css') return send(response, 200, 'text/css; charset=utf-8', style);
      if (request.method === 'GET' && suffix === '/api/session') return send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ title: payload.title, messageHtml, questions: payload.questions, documents, ...metadata }));
      if (request.method === 'POST' && suffix === '/api/submit') {
        const body = await requestBody(request);
        const answers = validateAnswers(payload, body.answers);
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
        completeOnce({ version: 1, status: 'submitted', ...metadata, answers, submittedAt: new Date().toISOString() });
        return;
      }
      if (request.method === 'POST' && suffix === '/api/cancel') {
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
        completeOnce({ version: 1, status: 'cancelled', ...metadata, answers: {} });
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
  const interrupt = () => completeOnce({ version: 1, status: 'cancelled', ...metadata, answers: {} });
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
    const { payload, documents, messageHtml } = await readPayload(args);
    const result = await serve(payload, documents, messageHtml, { ...args, askerPath, askerTmuxWindow });
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
