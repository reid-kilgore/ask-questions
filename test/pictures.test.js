import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { sanitizeSvg } from '../lib/pictures.js';

const cli = resolve('bin/ask-questions.js');
process.env.MAESTRO_PRESENCE_FILE = join(tmpdir(), `ask-questions-no-presence-pictures-${process.pid}.json`);
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function launch(args, { input = '', cwd = process.cwd() } = {}) {
  const { TMUX: _a, TMUX_PANE: _b, ...env } = process.env;
  const child = spawn('node', [cli, ...args, '--no-open', '--no-ding'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((done) => child.once('close', (code) => done(code)));
  child.stdin.end(input);
  return { child, closed, stderr: () => stderr };
}

async function urlOf(session) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = session.stderr().match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//);
    if (match) return match[0];
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`no URL: ${session.stderr()}`);
}

async function withForm(args, options, body) {
  const session = launch(args, options);
  try { await body(await urlOf(session)); } finally {
    session.child.kill('SIGTERM');
    await session.closed;
  }
}

const question = { id: 'q', prompt: 'Which design?', type: 'text' };
const payloadWith = (message, extra = {}) => JSON.stringify({ version: 1, message, questions: [question], ...extra });

async function fixtureDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'aq-pictures-'));
  await mkdir(join(dir, 'inside'));
  await writeFile(join(dir, 'inside', 'pic.png'), PNG);
  await writeFile(join(dir, 'inside', 'secret.png'), PNG);
  await writeFile(join(dir, 'outside.png'), PNG);
  await writeFile(join(dir, 'inside', 'notes.txt'), 'not an image');
  return dir;
}

test('mermaid fence becomes a diagram container carrying its source', async () => {
  await withForm(['--json', payloadWith('```mermaid\nflowchart LR\n  A --> B\n```')], {}, async (url) => {
    const session = await (await fetch(`${url}api/session`)).json();
    assert.match(session.messageHtml, /<pre class="diagram-source" data-diagram="mermaid"><code[^>]*>flowchart LR/);
  });
});

test('mermaid in a document is also a diagram container', async () => {
  const payload = payloadWith('hi', { documents: [{ id: 'd', title: 'D', markdown: '```mermaid\ngraph TD\n  X --> Y\n```' }] });
  await withForm(['--json', payload], {}, async (url) => {
    const session = await (await fetch(`${url}api/session`)).json();
    assert.match(session.documents[0].html, /data-diagram="mermaid"/);
  });
});

test('the page loads mermaid from a pinned CDN URL and falls back to the source', async () => {
  await withForm(['--json', payloadWith('x')], {}, async (url) => {
    const app = await (await fetch(`${url}app.js`)).text();
    assert.match(app, /cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\//);
    assert.match(app, /diagramState = 'failed'/);
  });
});

test('svg fence renders sanitised: no script, handlers, foreignObject or external href', async () => {
  const svg = '<svg viewBox="0 0 9 9" onload="alert(1)"><script>alert(2)</script><rect width="3" height="3" onclick="x()"/><foreignObject><div>h</div></foreignObject><use href="https://evil.example/a.svg#a"/><a href="javascript:alert(3)"><circle r="1"/></a></svg>';
  await withForm(['--json', payloadWith(`\`\`\`svg\n${svg}\n\`\`\``)], {}, async (url) => {
    const { messageHtml } = await (await fetch(`${url}api/session`)).json();
    const figure = messageHtml.slice(messageHtml.indexOf('<figure'), messageHtml.indexOf('</figure>'));
    assert.match(figure, /<svg viewBox="0 0 9 9">/);
    assert.match(figure, /<rect width="3" height="3">/);
    for (const bad of ['onload', 'onclick', '<script', 'alert', 'foreignObject', 'evil.example', 'javascript:']) {
      assert.ok(!figure.includes(bad), `figure must not contain ${bad}: ${figure}`);
    }
  });
});

test('sanitizeSvg survives hostile input', () => {
  const hostile = [
    '<svg><script>alert(1)</script></svg>',
    '<svg><ScRiPt>alert(1)</ScRiPt></svg>',
    '<svg onload=alert(1)></svg>',
    '<svg><image href="https://evil.example/x.png"/></svg>',
    '<svg><rect fill="url(https://evil.example/x)"/></svg>',
    '<svg><rect style="background:url(https://evil.example/x)"/></svg>',
    '<svg><style>@import "https://evil.example/x.css";</style></svg>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
    '<svg><use xlink:href="data:image/svg+xml;base64,AAAA#a"/></svg>',
    '<svg><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></svg>',
  ];
  for (const input of hostile) {
    const output = sanitizeSvg(input);
    assert.ok(!/<script|onload|onmouseover|<style|foreignObject|<iframe|<image|<animate|<set|evil\.example|javascript:|data:|<img/i.test(output), `${input} -> ${output}`);
  }
  assert.equal(sanitizeSvg('<svg><text>&lt;img src=x onerror=alert(1)&gt;</text></svg>'), '<svg><text>&lt;img src=x onerror=alert(1)&gt;</text></svg>', 'escaped markup in text stays inert text');
  assert.equal(sanitizeSvg('<img src=x onerror=alert(1)>'), '', 'input with no svg root yields nothing');
  assert.equal(sanitizeSvg('x'.repeat(300_000)), '', 'oversized input is refused');
  assert.match(sanitizeSvg('<svg viewBox="0 0 1 1"><use href="#a"/><rect fill="url(#g)"/></svg>'), /<use href="#a">.*fill="url\(#g\)"/, 'same-document references survive');
});

test('a referenced local image is served; an unreferenced one in the same directory is 404', async () => {
  const dir = await fixtureDirectory();
  try {
    await writeFile(join(dir, 'request.json'), payloadWith('![flow](inside/pic.png)'));
    await withForm(['--file', join(dir, 'request.json')], {}, async (url) => {
      const { messageHtml } = await (await fetch(`${url}api/session`)).json();
      assert.match(messageHtml, /<img src="img\/0\.png" alt="flow"/);
      const served = await fetch(`${url}img/0.png`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
      for (const attempt of ['img/secret.png', 'img/inside/secret.png', 'img/1.png', 'img/..%2foutside.png', 'img/%2e%2e/outside.png', 'img/0.png/../../outside.png', 'img/request.json']) {
        assert.equal((await fetch(`${url}${attempt}`)).status, 404, attempt);
      }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('images in documents resolve against the payload file directory', async () => {
  const dir = await fixtureDirectory();
  try {
    await writeFile(join(dir, 'request.json'), payloadWith('hi', { documents: [{ id: 'd', title: 'D', markdown: '![x](inside/pic.png)' }] }));
    await withForm(['--file', join(dir, 'request.json')], { cwd: tmpdir() }, async (url) => {
      const session = await (await fetch(`${url}api/session`)).json();
      assert.match(session.documents[0].html, /src="img\/0\.png"/);
      assert.equal((await fetch(`${url}img/0.png`)).status, 200);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('inline mode resolves images against the current directory', async () => {
  const dir = await fixtureDirectory();
  try {
    await withForm(['--json', payloadWith('![x](inside/pic.png)')], { cwd: dir }, async (url) => {
      assert.equal((await fetch(`${url}img/0.png`)).status, 200);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an image path that leaves the directory, a symlink out, a non-image file, or a missing file stops the launch', async () => {
  const dir = await fixtureDirectory();
  const base = join(dir, 'inside');
  try {
    await symlink(join(dir, 'outside.png'), join(base, 'link.png'));
    const cases = {
      '../outside.png': /stay within/,
      'link.png': /stay within/,
      'notes.txt': /not a supported image/,
      'missing.png': /Cannot/,
      '/etc/hosts.png': /relative/,
    };
    for (const [path, message] of Object.entries(cases)) {
      const session = launch(['--json', payloadWith(`![x](${path})`)], { cwd: base });
      assert.equal(await session.closed, 1, path);
      assert.match(session.stderr(), message, path);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('remote and data images are left as written, not turned into served files', async () => {
  await withForm(['--json', payloadWith('![r](https://example.com/a.png)')], {}, async (url) => {
    const { messageHtml } = await (await fetch(`${url}api/session`)).json();
    assert.match(messageHtml, /src="https:\/\/example\.com\/a\.png"/);
    assert.equal((await fetch(`${url}img/0.png`)).status, 404);
  });
});

test('help says pictures are expected and shows mermaid, svg and image path', async () => {
  const session = launch(['--help']);
  let out = '';
  session.child.stdout.on('data', (chunk) => { out += chunk; });
  assert.equal(await session.closed, 0);
  for (const text of ['Pictures (expected when the question is about a design choice, a flow, or a re-taught quiz miss)', '```mermaid', '```svg', '![alt text](diagrams/flow.png)']) {
    assert.ok(out.includes(text), text);
  }
});
