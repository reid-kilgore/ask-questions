import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContractError, parseArguments, resolveDocumentPath, validateAnswers, validatePayload } from '../lib/contract.js';

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
