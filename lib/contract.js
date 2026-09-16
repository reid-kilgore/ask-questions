import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { clearAnnotations, parse as parseAnnotations } from 'criticmarkup';

const questionTypes = new Set(['single', 'multiple', 'text', 'quiz']);

export class ContractError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(issues, location, message) {
  issues.push({ location, message });
}

function string(value, location, issues, { required = true } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length === 0) issue(issues, location, 'must be a non-empty string');
}

export function validatePayload(payload) {
  const issues = [];
  if (!isObject(payload)) throw new ContractError('Input must be a JSON object.', [{ location: 'payload', message: 'must be an object' }]);
  if (payload.version !== 1) issue(issues, 'version', 'must be 1');
  if (payload.title !== undefined) string(payload.title, 'title', issues);
  if (payload.message !== undefined) string(payload.message, 'message', issues);
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
    issue(issues, 'questions', 'must be a non-empty array');
  } else {
    const ids = new Set();
    payload.questions.forEach((question, questionIndex) => {
      const prefix = `questions[${questionIndex}]`;
      if (!isObject(question)) {
        issue(issues, prefix, 'must be an object');
        return;
      }
      string(question.id, `${prefix}.id`, issues);
      if (ids.has(question.id)) issue(issues, `${prefix}.id`, 'must be unique');
      ids.add(question.id);
      string(question.prompt, `${prefix}.prompt`, issues);
      if (!questionTypes.has(question.type)) issue(issues, `${prefix}.type`, 'must be single, multiple, text, or quiz');
      if (question.required !== undefined && typeof question.required !== 'boolean') issue(issues, `${prefix}.required`, 'must be a boolean');
      if (question.allowOther !== undefined && typeof question.allowOther !== 'boolean') issue(issues, `${prefix}.allowOther`, 'must be a boolean');
      if (question.placeholder !== undefined) string(question.placeholder, `${prefix}.placeholder`, issues, { required: false });
      const choiceQuestion = question.type === 'single' || question.type === 'multiple';
      const optionsQuestion = choiceQuestion || question.type === 'quiz';
      // allowOther is a single/multiple-only affordance; quiz never gets it,
      // even though quiz also carries options.
      if (!choiceQuestion && question.allowOther !== undefined) issue(issues, `${prefix}.allowOther`, 'is only valid for choice questions');
      // Choice questions offer Other by default. A caller opts out with `"allowOther": false`.
      if (choiceQuestion && question.allowOther === undefined) question.allowOther = true;
      if (optionsQuestion && (!Array.isArray(question.options) || question.options.length === 0)) {
        issue(issues, `${prefix}.options`, 'is required and must be a non-empty array for choice and quiz questions');
      }
      if (!optionsQuestion && question.options !== undefined) issue(issues, `${prefix}.options`, 'is only valid for choice and quiz questions');
      if (Array.isArray(question.options)) {
        const values = new Set();
        question.options.forEach((option, optionIndex) => {
          const optionPrefix = `${prefix}.options[${optionIndex}]`;
          if (!isObject(option)) {
            issue(issues, optionPrefix, 'must be an object');
            return;
          }
          string(option.value, `${optionPrefix}.value`, issues);
          string(option.label, `${optionPrefix}.label`, issues);
          if (option.description !== undefined) string(option.description, `${optionPrefix}.description`, issues, { required: false });
          if (values.has(option.value)) issue(issues, `${optionPrefix}.value`, 'must be unique within this question');
          values.add(option.value);
        });
      }
      if (question.type === 'quiz') {
        string(question.answer, `${prefix}.answer`, issues);
        if (question.why !== undefined) string(question.why, `${prefix}.why`, issues, { required: false });
        if (question.cite !== undefined) string(question.cite, `${prefix}.cite`, issues, { required: false });
        if (question.allowDisagree !== undefined && typeof question.allowDisagree !== 'boolean') issue(issues, `${prefix}.allowDisagree`, 'must be a boolean');
        if (question.allowDisagree === undefined) question.allowDisagree = true;
        if (typeof question.answer === 'string' && Array.isArray(question.options)) {
          const optionValues = new Set(question.options.map((option) => option.value));
          if (!optionValues.has(question.answer)) issue(issues, `${prefix}.answer`, 'must equal one of this question\'s option values');
        }
      } else if (question.answer !== undefined || question.why !== undefined || question.cite !== undefined || question.allowDisagree !== undefined) {
        issue(issues, prefix, 'answer, why, cite, and allowDisagree are only valid for quiz questions');
      }
    });
  }
  if (payload.documents !== undefined) {
    if (!Array.isArray(payload.documents)) {
      issue(issues, 'documents', 'must be an array');
    } else {
      const ids = new Set();
      payload.documents.forEach((document, index) => {
        const prefix = `documents[${index}]`;
        if (!isObject(document)) {
          issue(issues, prefix, 'must be an object');
          return;
        }
        string(document.id, `${prefix}.id`, issues);
        if (ids.has(document.id)) issue(issues, `${prefix}.id`, 'must be unique');
        ids.add(document.id);
        string(document.title, `${prefix}.title`, issues);
        const hasMarkdown = Object.hasOwn(document, 'markdown');
        const hasPath = Object.hasOwn(document, 'path');
        if (hasMarkdown === hasPath) issue(issues, prefix, 'must contain exactly one of markdown or path');
        if (hasMarkdown) string(document.markdown, `${prefix}.markdown`, issues, { required: false });
        if (hasPath) string(document.path, `${prefix}.path`, issues);
      });
    }
  }
  if (issues.length) throw new ContractError('The input payload is invalid.', issues);
  return payload;
}

export function parseArguments(argv) {
  const result = { noOpen: false, ding: true, json: undefined, file: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') result.help = true;
    else if (value === '--no-open') result.noOpen = true;
    else if (value === '--ding') result.ding = true;
    else if (value === '--no-ding') result.ding = false;
    else if (value === '--json') {
      if (result.json !== undefined) throw new ContractError('--json can be used only once.');
      result.json = argv[++index];
      if (result.json === undefined) throw new ContractError('--json requires a JSON value.');
    } else if (value === '--file') {
      if (result.file !== undefined) throw new ContractError('--file can be used only once.');
      result.file = argv[++index];
      if (result.file === undefined) throw new ContractError('--file requires a file path.');
    } else {
      throw new ContractError(`Unknown argument: ${value}`);
    }
  }
  if (result.json !== undefined && result.file !== undefined) throw new ContractError('--json and --file cannot be used together.');
  return result;
}

export function validateAnswers(payload, answers) {
  const issues = [];
  if (!Array.isArray(answers) || answers.length !== payload.questions.length) {
    throw new ContractError('Answers must contain one item for each question.', [{ location: 'answers', message: 'must match the question list' }]);
  }
  const answerById = new Map();
  answers.forEach((answer, index) => {
    if (!isObject(answer)) {
      issue(issues, `answers[${index}]`, 'must be an object');
      return;
    }
    if (typeof answer.questionId !== 'string') issue(issues, `answers[${index}].questionId`, 'must be a string');
    if (answerById.has(answer.questionId)) issue(issues, `answers[${index}].questionId`, 'must be unique');
    answerById.set(answer.questionId, answer);
    if (typeof answer.notes !== 'string') issue(issues, `answers[${index}].notes`, 'must be a string');
    if (answer.disagree !== undefined && typeof answer.disagree !== 'boolean') issue(issues, `answers[${index}].disagree`, 'must be a boolean');
  });
  const normalised = [];
  payload.questions.forEach((question) => {
    const answer = answerById.get(question.id);
    if (!answer) {
      issue(issues, `answers.${question.id}`, 'is missing');
      normalised.push([question.id, { value: null, notes: '' }]);
      return;
    }
    const value = answer.value;
    if (question.type === 'multiple') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) issue(issues, `answers.${question.id}.value`, 'must be an array of strings');
      else {
        if (new Set(value).size !== value.length) issue(issues, `answers.${question.id}.value`, 'must not contain duplicates');
        if (question.required && value.length === 0) issue(issues, `answers.${question.id}.value`, 'is required');
        const optionValues = new Set(question.options.map((option) => option.value));
        value.forEach((item) => { if (!optionValues.has(item) && !question.allowOther) issue(issues, `answers.${question.id}.value`, 'contains an unsupported option'); });
      }
    } else if (question.type === 'single') {
      if (value !== null && typeof value !== 'string') issue(issues, `answers.${question.id}.value`, 'must be a string or null');
      if (question.required && (typeof value !== 'string' || value.trim() === '')) issue(issues, `answers.${question.id}.value`, 'is required');
      const optionValues = new Set(question.options.map((option) => option.value));
      if (typeof value === 'string' && !optionValues.has(value) && !question.allowOther) issue(issues, `answers.${question.id}.value`, 'contains an unsupported option');
    } else if (question.type === 'quiz') {
      if (value !== null && typeof value !== 'string') issue(issues, `answers.${question.id}.value`, 'must be a string or null');
      if (question.required && (typeof value !== 'string' || value.trim() === '')) issue(issues, `answers.${question.id}.value`, 'is required');
      const optionValues = new Set(question.options.map((option) => option.value));
      if (typeof value === 'string' && !optionValues.has(value)) issue(issues, `answers.${question.id}.value`, 'contains an unsupported option');
      normalised.push([question.id, { value, notes: answer.notes, correct: value === question.answer, answer: question.answer, disagree: answer.disagree ?? false }]);
      return;
    } else {
      if (typeof value !== 'string') issue(issues, `answers.${question.id}.value`, 'must be a string');
      else if (question.required && value.trim() === '') issue(issues, `answers.${question.id}.value`, 'is required');
    }
    normalised.push([question.id, { value, notes: answer.notes }]);
  });
  if (issues.length) throw new ContractError('The submitted answers are invalid.', issues);
  return Object.fromEntries(normalised);
}

// A block/prompt/option's plain text, as the server computed it, is the
// sole authority an annotation is checked against — never a claim the
// client makes about its own DOM. `clearAnnotations` strips every
// CriticMarkup marker back out, so requiring the result to equal the known
// original both rejects malformed markup (stray `{==`/`==}` left over from
// a bad parse fails the equality) and rejects any edit to the underlying
// text itself: a submitted annotation can only ever add markers around
// text that was already there.
function validateAnnotatedText(issues, location, original, submitted) {
  if (typeof submitted !== 'string') {
    issue(issues, location, 'must be a string');
    return;
  }
  if (clearAnnotations(submitted) !== original) {
    issue(issues, location, 'must contain exactly the original text, with only CriticMarkup markers added');
    return;
  }
  // A comment with no highlighted text would arrive with nothing for the
  // calling agent to see it applied to.
  for (const annotation of parseAnnotations(submitted)) {
    if (annotation.comment !== null && annotation.highlight.trim() === '') {
      issue(issues, location, 'a comment must be attached to non-empty highlighted text');
    }
  }
}

/**
 * Validate a submitted `annotations` payload against `anchors`, the
 * server's own record of what each annotatable block/prompt/option's
 * plain text is (see lib/blockAnchor.js for documents and the message;
 * question prompts and option descriptions come straight from `payload`,
 * which never passes through the Markdown renderer).
 *
 * @param {object} payload - The validated request payload.
 * @param {{ message: Record<string, string>|null, documents: Record<string, Record<string, string>> }} anchors
 * @param {unknown} annotations - `body.annotations` from the submit request; may be undefined.
 * @returns {object} The normalised `annotations` result field: only keys with at least one entry are present.
 */
export function validateAnnotations(payload, anchors, annotations) {
  if (annotations === undefined) return {};
  const issues = [];
  if (!isObject(annotations)) throw new ContractError('The submitted annotations are invalid.', [{ location: 'annotations', message: 'must be an object' }]);

  const result = [];

  if (annotations.message !== undefined) {
    if (!anchors.message) issue(issues, 'annotations.message', 'this request has no message to annotate');
    else if (!isObject(annotations.message)) issue(issues, 'annotations.message', 'must be an object');
    else {
      const blocks = [];
      for (const [blockId, text] of Object.entries(annotations.message)) {
        // Object.hasOwn, not a plain index/truthiness read: `blockId` is
        // attacker-controlled, and a plain-object index read on a key like
        // "__proto__" resolves through the prototype chain to Object.prototype
        // instead of correctly missing. The comparison below would still
        // reject that case (a string can never equal an object), but this
        // is the correct guard, not an incidental one.
        if (!Object.hasOwn(anchors.message, blockId)) { issue(issues, `annotations.message.${blockId}`, 'is not a known block in the message'); continue; }
        const original = anchors.message[blockId];
        validateAnnotatedText(issues, `annotations.message.${blockId}`, original, text);
        blocks.push([blockId, text]);
      }
      if (blocks.length) result.push(['message', Object.fromEntries(blocks)]);
    }
  }

  if (annotations.documents !== undefined) {
    if (!isObject(annotations.documents)) issue(issues, 'annotations.documents', 'must be an object');
    else {
      const documentEntries = [];
      for (const [documentId, blocks] of Object.entries(annotations.documents)) {
        // Same Object.hasOwn concern as above: `documentId` is a document id
        // the calling agent chose, and this project deliberately keeps
        // "__proto__" usable as an ordinary id (see the __proto__ tests).
        if (!Object.hasOwn(anchors.documents, documentId)) { issue(issues, `annotations.documents.${documentId}`, 'is not a known document'); continue; }
        const documentAnchors = anchors.documents[documentId];
        if (!isObject(blocks)) { issue(issues, `annotations.documents.${documentId}`, 'must be an object'); continue; }
        const blockEntries = [];
        for (const [blockId, text] of Object.entries(blocks)) {
          if (!Object.hasOwn(documentAnchors, blockId)) { issue(issues, `annotations.documents.${documentId}.${blockId}`, 'is not a known block in this document'); continue; }
          const original = documentAnchors[blockId];
          validateAnnotatedText(issues, `annotations.documents.${documentId}.${blockId}`, original, text);
          blockEntries.push([blockId, text]);
        }
        if (blockEntries.length) documentEntries.push([documentId, Object.fromEntries(blockEntries)]);
      }
      if (documentEntries.length) result.push(['documents', Object.fromEntries(documentEntries)]);
    }
  }

  if (annotations.questions !== undefined) {
    if (!isObject(annotations.questions)) issue(issues, 'annotations.questions', 'must be an object');
    else {
      const questionsById = new Map(payload.questions.map((question) => [question.id, question]));
      const questionEntries = [];
      for (const [questionId, entry] of Object.entries(annotations.questions)) {
        const question = questionsById.get(questionId);
        if (!question) { issue(issues, `annotations.questions.${questionId}`, 'is not a known question'); continue; }
        if (!isObject(entry)) { issue(issues, `annotations.questions.${questionId}`, 'must be an object'); continue; }
        const fields = [];
        if (entry.prompt !== undefined) {
          validateAnnotatedText(issues, `annotations.questions.${questionId}.prompt`, question.prompt, entry.prompt);
          fields.push(['prompt', entry.prompt]);
        }
        if (entry.options !== undefined) {
          if (!isObject(entry.options)) issue(issues, `annotations.questions.${questionId}.options`, 'must be an object');
          else {
            const optionsByValue = new Map((question.options ?? []).map((option) => [option.value, option]));
            const optionEntries = [];
            for (const [optionValue, text] of Object.entries(entry.options)) {
              const option = optionsByValue.get(optionValue);
              if (!option || option.description === undefined) { issue(issues, `annotations.questions.${questionId}.options.${optionValue}`, 'is not a known option description for this question'); continue; }
              validateAnnotatedText(issues, `annotations.questions.${questionId}.options.${optionValue}`, option.description, text);
              optionEntries.push([optionValue, text]);
            }
            if (optionEntries.length) fields.push(['options', Object.fromEntries(optionEntries)]);
          }
        }
        if (fields.length) questionEntries.push([questionId, Object.fromEntries(fields)]);
      }
      if (questionEntries.length) result.push(['questions', Object.fromEntries(questionEntries)]);
    }
  }

  if (issues.length) throw new ContractError('The submitted annotations are invalid.', issues);
  return Object.fromEntries(result);
}

export async function resolveDocumentPath(baseDirectory, documentPath) {
  if (path.isAbsolute(documentPath)) throw new ContractError('Document paths must be relative.', [{ location: 'documents.path', message: 'must be a relative path' }]);
  const resolved = path.resolve(baseDirectory, documentPath);
  const relative = path.relative(baseDirectory, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new ContractError('Document paths must stay within the input directory.', [{ location: 'documents.path', message: 'must not leave the input directory' }]);
  }
  let realBaseDirectory;
  let realDocumentPath;
  try {
    [realBaseDirectory, realDocumentPath] = await Promise.all([realpath(baseDirectory), realpath(resolved)]);
  } catch (error) {
    throw new ContractError(`Cannot resolve document path ${documentPath}: ${error.message}`);
  }
  const realRelative = path.relative(realBaseDirectory, realDocumentPath);
  if (realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) {
    throw new ContractError('Document paths must stay within the input directory.', [{ location: 'documents.path', message: 'must not leave the input directory through a symbolic link' }]);
  }
  return realDocumentPath;
}
