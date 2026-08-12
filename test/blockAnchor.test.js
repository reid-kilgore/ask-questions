import assert from 'node:assert/strict';
import test from 'node:test';
import MarkdownIt from 'markdown-it';
import { installBlockAnchors } from '../lib/blockAnchor.js';

function render(source) {
  const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
  installBlockAnchors(markdown);
  const env = {};
  const html = markdown.render(source, env);
  return { html, blockText: env.blockText };
}

test('stamps a source-line-range data-block onto block elements', () => {
  const { html } = render('# Heading\n\nA paragraph.\n');
  assert.match(html, /<h1 data-block="0-1">Heading<\/h1>/);
  assert.match(html, /<p data-block="2-3">A paragraph\.<\/p>/);
});

test('extracts each block\'s plain text, matching what element.textContent would read', () => {
  const { blockText } = render('# Heading\n\nA paragraph with *emphasis* and `code`.\n');
  assert.equal(blockText['0-1'], 'Heading');
  assert.equal(blockText['2-3'], 'A paragraph with emphasis and code.');
});

test('typographer substitutions land in blockText, matching the rendered HTML', () => {
  const { html, blockText } = render('A paragraph -- with "quotes" and an em dash---here.\n');
  // The exact characters typographer substitutes are asserted against the
  // real render, not hard-coded, so this test tracks markdown-it's actual
  // behavior rather than an assumption about it.
  const rendered = html.match(/<p data-block="0-1">([\s\S]*)<\/p>/)[1];
  assert.equal(blockText['0-1'], rendered);
});

test('a soft line break and a hard line break each contribute exactly one newline', () => {
  const { blockText } = render('one\ntwo  \nthree\n');
  assert.equal(blockText['0-3'], 'one\ntwo\nthree');
});

test('fenced code keeps its data-block and its content matches blockText exactly', () => {
  const { html, blockText } = render('```js\nconst x = 1;\n```\n');
  assert.match(html, /data-block="0-3"/);
  assert.equal(blockText['0-3'], 'const x = 1;\n');
});

test('an indented code block is anchored the same way as a fenced one', () => {
  const { html, blockText } = render('    const x = 1;\n');
  assert.match(html, /<pre data-block="0-1">/);
  assert.equal(blockText['0-1'], 'const x = 1;\n');
});

test('nested blocks (a blockquote wrapping one paragraph) get the same id when their ranges coincide', () => {
  const { html, blockText } = render('> a quote\n> continues\n');
  assert.match(html, /<blockquote data-block="0-2">/);
  assert.match(html, /<p data-block="0-2">/);
  assert.equal(blockText['0-2'], 'a quote\ncontinues');
});

test('list items each get their own narrower range than the list that contains them', () => {
  const { blockText } = render('- item one\n- item two\n');
  assert.equal(blockText['0-1'], 'item one');
  assert.equal(blockText['1-2'], 'item two');
});

test('table cells with no map of their own do not leak a "null" key into blockText', () => {
  const { blockText } = render('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.equal(Object.hasOwn(blockText, 'null'), false);
  assert.equal(blockText['0-3'], 'ab12');
});

test('a block with no text of its own (an empty document) has no data-block and no blockText', () => {
  const { html, blockText } = render('');
  assert.equal(html, '');
  assert.deepEqual(blockText, {});
});
