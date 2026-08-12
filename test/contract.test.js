import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContractError, parseArguments, resolveDocumentPath, validateAnnotations, validateAnswers, validatePayload } from '../lib/contract.js';

const payload = { version: 1, questions: [{ id: 'choice', prompt: 'Choose', type: 'single', required: true, options: [{ value: 'yes', label: 'Yes' }] }, { id: 'text', prompt: 'Explain', type: 'text' }] };

test('accepts valid payload and answers', () => {
  assert.equal(validatePayload(payload), payload);
  assert.deepEqual(validateAnswers(payload, [{ questionId: 'choice', value: 'yes', notes: '' }, { questionId: 'text', value: '', notes: 'optional' }]), {
    choice: { value: 'yes', notes: '' },
    text: { value: '', notes: 'optional' },
  });
});

test('preserves a __proto__ question id as an own keyed answer', () => {
  const protoPayload = {
    version: 1,
    questions: [{ id: '__proto__', prompt: 'Explain', type: 'text', required: true }],
  };
  const answers = validateAnswers(protoPayload, [{ questionId: '__proto__', value: 'Answer', notes: '' }]);
  assert.equal(Object.hasOwn(answers, '__proto__'), true);
  assert.deepEqual(answers.__proto__, { value: 'Answer', notes: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), JSON.parse('{"__proto__":{"value":"Answer","notes":""}}'));
});

test('returns a contract error for a non-string text answer', () => {
  assert.throws(() => validateAnswers(payload, [{ questionId: 'choice', value: 'yes', notes: '' }, { questionId: 'text', value: 42, notes: '' }]), ContractError);
});

test('defaults choice questions to allowOther: true', () => {
  const singlePayload = { version: 1, questions: [{ id: 'choice', prompt: 'Choose', type: 'single', options: [{ value: 'yes', label: 'Yes' }] }] };
  validatePayload(singlePayload);
  assert.equal(singlePayload.questions[0].allowOther, true);

  const multiplePayload = { version: 1, questions: [{ id: 'choice', prompt: 'Choose', type: 'multiple', options: [{ value: 'yes', label: 'Yes' }] }] };
  validatePayload(multiplePayload);
  assert.equal(multiplePayload.questions[0].allowOther, true);

  const answers = validateAnswers(singlePayload, [{ questionId: 'choice', value: 'not-an-option', notes: '' }]);
  assert.equal(answers.choice.value, 'not-an-option');
});

test('leaves text questions without an allowOther field', () => {
  const textPayload = { version: 1, questions: [{ id: 'text', prompt: 'Explain', type: 'text' }] };
  validatePayload(textPayload);
  assert.equal(textPayload.questions[0].allowOther, undefined);
});

test('keeps an explicit allowOther: false as an opt-out', () => {
  const optOutPayload = { version: 1, questions: [{ id: 'choice', prompt: 'Choose', type: 'single', allowOther: false, options: [{ value: 'yes', label: 'Yes' }] }] };
  validatePayload(optOutPayload);
  assert.equal(optOutPayload.questions[0].allowOther, false);
  assert.throws(() => validateAnswers(optOutPayload, [{ questionId: 'choice', value: 'not-an-option', notes: '' }]), ContractError);
});

test('rejects duplicate question ids and invalid choice options', () => {
  assert.throws(() => validatePayload({ version: 1, questions: [{ id: 'same', prompt: 'One', type: 'single', options: [] }, { id: 'same', prompt: 'Two', type: 'invalid' }] }), ContractError);
  assert.throws(() => validatePayload({ version: 1, questions: [{ id: 'text', prompt: 'A text question', type: 'text', allowOther: true }] }), ContractError);
});

test('rejects invalid documents and lexical traversal', async () => {
  assert.throws(() => validatePayload({ version: 1, questions: payload.questions, documents: [{ id: 'a', title: 'A', markdown: 'x', path: 'x.md' }] }), ContractError);
  await assert.rejects(resolveDocumentPath('/tmp/base', '../outside.md'), ContractError);
});

test('rejects a document symlink that points outside the input directory', async () => {
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'ask-questions-base-'));
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), 'ask-questions-outside-'));
  try {
    const outsideDocument = path.join(outsideDirectory, 'outside.md');
    await writeFile(outsideDocument, '# outside');
    await symlink(outsideDocument, path.join(baseDirectory, 'linked.md'));
    await assert.rejects(resolveDocumentPath(baseDirectory, 'linked.md'), ContractError);
  } finally {
    await Promise.all([rm(baseDirectory, { recursive: true, force: true }), rm(outsideDirectory, { recursive: true, force: true })]);
  }
});

test('parses ding as enabled by default and lets the last ding flag win', () => {
  assert.deepEqual(parseArguments(['--json', '{}']), { help: false, json: '{}', file: undefined, noOpen: false, ding: true });
  assert.deepEqual(parseArguments(['--json', '{}', '--no-ding']), { help: false, json: '{}', file: undefined, noOpen: false, ding: false });
  assert.deepEqual(parseArguments(['--json', '{}', '--no-ding', '--ding']), { help: false, json: '{}', file: undefined, noOpen: false, ding: true });
  assert.deepEqual(parseArguments(['--json', '{}', '--ding', '--no-ding']), { help: false, json: '{}', file: undefined, noOpen: false, ding: false });
});

test('parses input mode arguments and rejects mixed modes', () => {
  assert.deepEqual(parseArguments(['--json', '{}', '--no-open', '--ding']), { help: false, json: '{}', file: undefined, noOpen: true, ding: true });
  assert.throws(() => parseArguments(['--json', '{}', '--file', 'request.json']), ContractError);
});

const annotationPayload = {
  version: 1,
  message: 'A message',
  questions: [{ id: 'choice', prompt: 'Which risk needs attention?', type: 'single', options: [{ value: 'rollback', label: 'Rollback', description: 'Revert the release.' }] }],
};
const annotationAnchors = {
  message: { '0-1': 'A message' },
  documents: { notes: { '0-1': 'Some notes.' } },
};

test('returns an empty object when no annotations were submitted', () => {
  assert.deepEqual(validateAnnotations(annotationPayload, annotationAnchors, undefined), {});
});

test('rejects a non-object annotations value', () => {
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, 'nope'), ContractError);
});

test('accepts a highlight on each of the four annotatable surfaces and keeps only the entries actually annotated', () => {
  const result = validateAnnotations(annotationPayload, annotationAnchors, {
    message: { '0-1': 'A {==message==}' },
    documents: { notes: { '0-1': '{==Some==} notes.' } },
    questions: {
      choice: {
        prompt: 'Which {==risk==}{>>be specific<<} needs attention?',
        options: { rollback: '{==Revert==} the release.' },
      },
    },
  });
  assert.deepEqual(result, {
    message: { '0-1': 'A {==message==}' },
    documents: { notes: { '0-1': '{==Some==} notes.' } },
    questions: { choice: { prompt: 'Which {==risk==}{>>be specific<<} needs attention?', options: { rollback: '{==Revert==} the release.' } } },
  });
});

test('omits documents/questions with no annotated blocks at all', () => {
  assert.deepEqual(validateAnnotations(annotationPayload, annotationAnchors, { documents: {}, questions: {} }), {});
});

test('rejects a message annotation when the request has no message', () => {
  const anchorsWithoutMessage = { message: null, documents: {} };
  assert.throws(() => validateAnnotations(annotationPayload, anchorsWithoutMessage, { message: { '0-1': 'x' } }), ContractError);
});

test('rejects an unknown block id, document id, question id, and option value', () => {
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { message: { '9-9': 'x' } }), ContractError);
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { documents: { missing: { '0-1': 'x' } } }), ContractError);
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { documents: { notes: { '9-9': 'x' } } }), ContractError);
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { questions: { missing: { prompt: 'x' } } }), ContractError);
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { questions: { choice: { options: { missing: 'x' } } } }), ContractError);
});

test('rejects annotated text that does not clear back to exactly the original text', () => {
  // Edited text, not just marked-up text: the server, not the browser, is
  // the authority on what a block's plain text is.
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { message: { '0-1': 'A {==different message==}' } }), ContractError);
  // Stray/unterminated CriticMarkup markup also fails the clearAnnotations comparison.
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { message: { '0-1': 'A {==message' } }), ContractError);
});

test('rejects a comment attached to an empty highlight', () => {
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { message: { '0-1': 'A message{====}{>>orphaned comment<<}' } }), ContractError);
});

test('rejects a non-string annotated value', () => {
  assert.throws(() => validateAnnotations(annotationPayload, annotationAnchors, { message: { '0-1': 42 } }), ContractError);
});

test('rejects a "__proto__" block/document id that was never a real anchor, instead of resolving it through the prototype chain', () => {
  // A plain-object index read on "__proto__" returns Object.prototype
  // instead of correctly missing, unless the guard uses Object.hasOwn.
  // This asserts the rejection reason is the ordinary "not a known ..."
  // issue, not a comparison against an object that happened to fail for
  // an unrelated reason.
  // Object literal syntax with a literal "__proto__" key does not create an
  // own property at all (it either sets the prototype or, for a non-object
  // value like these, is ignored) — Object.fromEntries is what actually
  // produces an own "__proto__" property, the same as JSON.parse does for
  // real submitted input.
  const messageResult = (() => {
    try {
      validateAnnotations(annotationPayload, annotationAnchors, { message: Object.fromEntries([['__proto__', 'x']]) });
    } catch (error) {
      return error;
    }
    throw new Error('expected a ContractError');
  })();
  assert.ok(messageResult instanceof ContractError);
  assert.ok(messageResult.issues.some((issueEntry) => issueEntry.location === 'annotations.message.__proto__' && issueEntry.message === 'is not a known block in the message'));

  assert.throws(
    () => validateAnnotations(annotationPayload, annotationAnchors, { documents: Object.fromEntries([['__proto__', { '0-1': 'x' }]]) }),
    (error) => error instanceof ContractError && error.issues.some((issueEntry) => issueEntry.location === 'annotations.documents.__proto__' && issueEntry.message === 'is not a known document'),
  );

  assert.throws(
    () => validateAnnotations(annotationPayload, annotationAnchors, { documents: { notes: Object.fromEntries([['__proto__', 'x']]) } }),
    (error) => error instanceof ContractError && error.issues.some((issueEntry) => issueEntry.location === 'annotations.documents.notes.__proto__' && issueEntry.message === 'is not a known block in this document'),
  );
});

test('preserves a __proto__ document id as an own keyed entry', () => {
  // Object literal syntax and plain bracket assignment both route a
  // "__proto__" key through Object.prototype's accessor instead of
  // creating an own property, unlike JSON.parse (and Object.fromEntries)
  // on real input — so the fixtures here must go through fromEntries too,
  // to actually exercise the case a submitted payload can produce.
  const anchors = { message: null, documents: Object.fromEntries([['__proto__', { '0-1': 'x' }]]) };
  const body = { documents: Object.fromEntries([['__proto__', { '0-1': '{==x==}' }]]) };
  const result = validateAnnotations(annotationPayload, anchors, body);
  assert.equal(Object.hasOwn(result.documents, '__proto__'), true);
  assert.deepEqual(result.documents.__proto__, { '0-1': '{==x==}' });
});
