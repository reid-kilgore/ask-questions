import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// See test-helpers/vendorLoader.mjs for why this redirect is needed to
// import web/annotate.js from Node at all.
register('../test-helpers/vendorLoader.mjs', import.meta.url);
const { assembleAnnotations, firstOccurrenceOnly, unsafeDelimiterReason } = await import('../web/annotate.js');

// --- unsafeDelimiterReason: refusing markup that cannot round-trip -----------------------------
// CriticMarkup has no escape mechanism (see the criticmarkup README): this
// is the client-side half of the fix for text/comments containing a
// delimiter the server-side round-trip check (lib/contract.js) would
// otherwise reject with no indication of which mark caused it.

test('unsafeDelimiterReason allows ordinary highlights and comments', () => {
  assert.equal(unsafeDelimiterReason('ordinary text', null), null);
  assert.equal(unsafeDelimiterReason('ordinary text', 'an ordinary comment'), null);
});

test('unsafeDelimiterReason refuses a highlight containing the highlight terminator', () => {
  const reason = unsafeDelimiterReason('a highlight containing ==} right there', null);
  assert.match(reason, /==\}/);
});

test('unsafeDelimiterReason refuses a comment containing the comment terminator', () => {
  const reason = unsafeDelimiterReason('ordinary text', 'a comment containing <<} right there');
  assert.match(reason, /<<\}/);
});

test('unsafeDelimiterReason ignores a comment terminator inside the comment when comment is null', () => {
  // Only the highlight is being created (the "Highlight" button, not
  // "Comment") — there is no comment to check yet.
  assert.equal(unsafeDelimiterReason('ordinary text', null), null);
});

// --- firstOccurrenceOnly: deduplicating a container/child sharing a block id -----------------------------
// A blockquote wrapping exactly one paragraph gets the same data-block id
// on both elements (see lib/blockAnchor.js and its tests); hydrating both
// would wrap the same stored range twice, producing a mark nested inside a
// mark and a duplicate Tab stop.

test('firstOccurrenceOnly keeps every id when there are no duplicates', () => {
  assert.deepEqual(firstOccurrenceOnly(['0-1', '2-3', '4-5']), [true, true, true]);
});

test('firstOccurrenceOnly keeps only the first of two elements sharing a block id', () => {
  assert.deepEqual(firstOccurrenceOnly(['0-2', '0-2']), [true, false]);
});

test('firstOccurrenceOnly keeps unrelated ids interleaved with a duplicate pair', () => {
  assert.deepEqual(firstOccurrenceOnly(['0-2', '2-4', '0-2', '4-5']), [true, true, false, true]);
});

// --- assembleAnnotations: the result shape, and the prototype-pollution fix -----------------------------
// This is the exact function that had the bug: plain-object bracket
// assignment on an attacker-controlled key (`documents[documentId] ??= {}`)
// does not create an own property for "__proto__" — it resolves through
// Object.prototype's own accessor and pollutes it. The fix accumulates
// through Maps (immune to that) and converts with Object.fromEntries
// (which defines own properties directly) only at the end, the same
// pattern lib/contract.js already uses for question/document ids.

function target(key, text) {
  return [JSON.stringify(key), { key, text }];
}

test('assembleAnnotations builds the nested result shape for all four surfaces', () => {
  const targets = new Map([
    target(['message', '2-3'], 'a rewritten sentence would be clearer'),
    target(['document', 'doc-id', '0-1'], 'the risky part'),
    target(['prompt', 'question-id'], 'which..?'),
    target(['option', 'question-id', 'option-value'], 'an option description'),
  ]);
  const store = new Map([
    [JSON.stringify(['message', '2-3']), [{ start: 30, end: 38, comment: 'say why' }]],
    [JSON.stringify(['document', 'doc-id', '0-1']), [{ start: 4, end: 14, comment: null }]],
    [JSON.stringify(['prompt', 'question-id']), [{ start: 0, end: 8, comment: null }]],
    [JSON.stringify(['option', 'question-id', 'option-value']), [{ start: 0, end: 21, comment: null }]],
  ]);
  assert.deepEqual(assembleAnnotations(store, targets), {
    message: { '2-3': 'a rewritten sentence would be {==clearer==}{>>say why<<}' },
    documents: { 'doc-id': { '0-1': 'the {==risky part==}' } },
    questions: { 'question-id': { prompt: '{==which..?==}', options: { 'option-value': '{==an option description==}' } } },
  });
});

test('assembleAnnotations omits keys with no stored ranges', () => {
  assert.deepEqual(assembleAnnotations(new Map(), new Map()), {});
});

test('assembleAnnotations does not pollute Object.prototype for a "__proto__" document id', () => {
  const targets = new Map([target(['document', '__proto__', '0-1'], 'x')]);
  const store = new Map([[JSON.stringify(['document', '__proto__', '0-1']), [{ start: 0, end: 1, comment: null }]]]);
  const result = assembleAnnotations(store, targets);
  assert.equal(Object.hasOwn(result.documents, '__proto__'), true);
  assert.deepEqual(result.documents.__proto__, { '0-1': '{==x==}' });
  // The actual regression: before the fix, this assignment landed on
  // Object.prototype itself, so a brand-new unrelated plain object would
  // incorrectly inherit a "0-1" property.
  assert.equal(Object.hasOwn({}, '0-1'), false);
  assert.equal(({}).hasOwnProperty('0-1'), false);
});

test('assembleAnnotations does not pollute Object.prototype for a "__proto__" question id', () => {
  const targets = new Map([target(['option', '__proto__', 'opt'], 'x')]);
  const store = new Map([[JSON.stringify(['option', '__proto__', 'opt']), [{ start: 0, end: 1, comment: null }]]]);
  const result = assembleAnnotations(store, targets);
  assert.equal(Object.hasOwn(result.questions, '__proto__'), true);
  assert.deepEqual(result.questions.__proto__, { options: { opt: '{==x==}' } });
  // Before the fix, `questions[questionId] ??= {}` read Object.prototype
  // (truthy, so the guard let it through) and `.options ??= {}` then wrote
  // an "options" property onto Object.prototype itself, shared by every
  // plain object on the page from then on.
  assert.equal(Object.hasOwn({}, 'options'), false);
});
