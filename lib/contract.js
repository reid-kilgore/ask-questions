import path from 'node:path';
import { realpath } from 'node:fs/promises';

const questionTypes = new Set(['single', 'multiple', 'text']);

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
      if (!questionTypes.has(question.type)) issue(issues, `${prefix}.type`, 'must be single, multiple, or text');
      if (question.required !== undefined && typeof question.required !== 'boolean') issue(issues, `${prefix}.required`, 'must be a boolean');
      if (question.allowOther !== undefined && typeof question.allowOther !== 'boolean') issue(issues, `${prefix}.allowOther`, 'must be a boolean');
      if (question.placeholder !== undefined) string(question.placeholder, `${prefix}.placeholder`, issues, { required: false });
      const choiceQuestion = question.type === 'single' || question.type === 'multiple';
      if (!choiceQuestion && question.allowOther !== undefined) issue(issues, `${prefix}.allowOther`, 'is only valid for choice questions');
      if (choiceQuestion && (!Array.isArray(question.options) || question.options.length === 0)) {
        issue(issues, `${prefix}.options`, 'is required and must be a non-empty array for choice questions');
      }
      if (!choiceQuestion && question.options !== undefined) issue(issues, `${prefix}.options`, 'is only valid for choice questions');
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
    } else {
      if (typeof value !== 'string') issue(issues, `answers.${question.id}.value`, 'must be a string');
      else if (question.required && value.trim() === '') issue(issues, `answers.${question.id}.value`, 'is required');
    }
    normalised.push([question.id, { value, notes: answer.notes }]);
  });
  if (issues.length) throw new ContractError('The submitted answers are invalid.', issues);
  return Object.fromEntries(normalised);
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
