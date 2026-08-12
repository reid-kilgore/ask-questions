import { attachDocument, attachMessage, attachOption, attachPrompt, buildAnnotationsPayload } from './annotate.js';

const session = await fetch('api/session').then(async (response) => {
  if (!response.ok) throw new Error('The local session is unavailable.');
  return response.json();
});

const create = (name, properties = {}) => {
  const element = document.createElement(name);
  Object.assign(element, properties);
  return element;
};

const form = document.querySelector('#question-form');
const questions = document.querySelector('#questions');
const review = document.querySelector('#review');
const reviewSummary = document.querySelector('#review-summary');
const summary = document.querySelector('#summary');
const submitButton = form.querySelector('[type="submit"]');
const cancelButton = document.querySelector('#cancel');
const copyJsonButton = document.querySelector('#copy-json');
const copyStatus = document.querySelector('#copy-status');
const previousQuestion = document.querySelector('#previous-question');
const nextQuestion = document.querySelector('#next-question');
const completion = document.querySelector('#completion');
const cardsByQuestionId = new Map();
const otherValueSynchronisers = [];
let focused = true;
let focusedQuestionIndex = 0;
let reviewing = false;

document.title = session.title || 'Questions';
document.querySelector('#page-title').textContent = session.title || 'Questions';
const askerPath = document.querySelector('#asker-path');
askerPath.textContent = session.askerPath;
askerPath.title = 'Click to copy';
askerPath.addEventListener('click', () => navigator.clipboard?.writeText(session.askerPath).catch(() => {}));
if (session.askerTmuxWindow) {
  const askerTmuxWindow = document.querySelector('#asker-tmux-window');
  askerTmuxWindow.textContent = `tmux: ${session.askerTmuxWindow}`;
  askerTmuxWindow.hidden = false;
}
if (session.messageHtml) {
  const message = document.querySelector('#message');
  attachMessage(message, session.messageHtml, session.messageBlockText);
  message.hidden = false;
}

function addOption(card, question, option, questionIndex, optionIndex) {
  const inputId = `question-${questionIndex}-option-${optionIndex}`;
  const label = create('label', { className: 'option', htmlFor: inputId });
  const input = create('input', {
    id: inputId,
    type: question.type === 'single' ? 'radio' : 'checkbox',
    name: `question-${questionIndex}`,
    value: option.value,
  });
  const content = create('span');
  content.append(create('strong', { textContent: option.label }));
  if (option.description) {
    const description = create('small');
    content.append(description);
    attachOption(description, question.id, option.value, option.description);
  }
  label.append(input, content);
  card.append(label);
}

function addOtherOption(card, question, questionIndex) {
  const inputId = `question-${questionIndex}-other`;
  const label = create('label', { className: 'option', htmlFor: inputId });
  const toggle = create('input', {
    id: inputId,
    className: 'other-toggle',
    type: question.type === 'single' ? 'radio' : 'checkbox',
    name: `question-${questionIndex}`,
    value: '__other__',
  });
  label.append(toggle, create('span'));
  label.lastElementChild.append(create('strong', { textContent: 'Other' }));
  const value = create('input', {
    className: 'other-value',
    type: 'text',
    placeholder: question.placeholder || 'Enter another answer',
    hidden: true,
    disabled: true,
  });
  const synchronise = () => {
    const selected = toggle.checked;
    value.hidden = !selected;
    value.disabled = !selected;
    if (!selected) value.value = '';
  };
  card.addEventListener('change', synchronise);
  synchronise();
  card.append(label, value);
  return synchronise;
}

session.questions.forEach((question, questionIndex) => {
  const card = create('fieldset', { className: 'question-card' });
  cardsByQuestionId.set(question.id, card);
  const legend = create('legend');
  const promptText = create('span', { className: 'prompt-text' });
  attachPrompt(promptText, question.id, question.prompt);
  legend.append(promptText, ' ', create('span', {
    className: question.required ? 'required' : 'optional',
    textContent: question.required ? 'Required' : 'Optional',
  }));
  card.append(legend);

  if (question.type === 'text') {
    card.append(create('textarea', { className: 'answer', rows: 4, placeholder: question.placeholder || '' }));
  } else {
    const options = create('div', { className: 'options' });
    question.options.forEach((option, optionIndex) => addOption(options, question, option, questionIndex, optionIndex));
    card.append(options);
    if (question.allowOther) otherValueSynchronisers.push(addOtherOption(card, question, questionIndex));
  }

  const notesLabel = create('label', { className: 'notes-label', textContent: 'Notes for the agent' });
  notesLabel.append(create('textarea', {
    className: 'notes',
    rows: 3,
    placeholder: 'Optional context, rationale, or follow-up',
  }));
  card.append(notesLabel);
  questions.append(card);
});

const allQuestionsButton = document.querySelector('#all-questions');
const focusedQuestionButton = document.querySelector('#focused-question');
const focusProgress = document.querySelector('#focus-progress');
const shortcutHint = document.querySelector('#shortcut-hint');

function updateQuestionView() {
  questions.hidden = reviewing;
  review.hidden = !reviewing;
  questions.classList.toggle('focused-stage', focused && !reviewing);
  session.questions.forEach((question, index) => {
    cardsByQuestionId.get(question.id).hidden = focused && (reviewing || index !== focusedQuestionIndex);
  });
  allQuestionsButton.classList.toggle('active', !focused);
  allQuestionsButton.ariaPressed = String(!focused);
  focusedQuestionButton.classList.toggle('active', focused);
  focusedQuestionButton.ariaPressed = String(focused);
  previousQuestion.hidden = !focused;
  nextQuestion.hidden = !focused || reviewing;
  cancelButton.hidden = focused && !reviewing;
  copyJsonButton.hidden = !reviewing;
  submitButton.hidden = focused && !reviewing;
  if (focused && !reviewing) {
    focusProgress.textContent = `Question ${focusedQuestionIndex + 1} of ${session.questions.length}`;
    shortcutHint.textContent = '⌘/Ctrl + Enter: Next';
    shortcutHint.hidden = false;
    previousQuestion.disabled = focusedQuestionIndex === 0;
    nextQuestion.textContent = focusedQuestionIndex === session.questions.length - 1 ? 'Review answers' : 'Next';
  } else if (reviewing) {
    focusProgress.textContent = 'Review answers';
    shortcutHint.textContent = '⌘/Ctrl + Enter: Submit';
    shortcutHint.hidden = false;
    previousQuestion.disabled = false;
  } else {
    focusProgress.textContent = 'All questions visible';
    shortcutHint.hidden = true;
  }
}

function showRequiredQuestions(requiredQuestions) {
  if (requiredQuestions.length === 0) return true;
  summary.textContent = `Complete required questions: ${requiredQuestions.map((question) => question.prompt).join('; ')}`;
  summary.hidden = false;
  return false;
}

function readAnswer(question) {
  const card = cardsByQuestionId.get(question.id);
  let value;
  if (question.type === 'text') value = card.querySelector('.answer').value;
  else {
    const selected = [...card.querySelectorAll('input:checked')].map((input) => input.value);
    const other = card.querySelector('.other-value');
    const otherValue = other?.value.trim();
    const values = selected.flatMap((item) => item === '__other__' ? (otherValue ? [otherValue] : []) : [item]);
    value = question.type === 'multiple' ? values : (values[0] ?? null);
  }
  return { questionId: question.id, value, notes: card.querySelector('.notes').value };
}

function readAnswers() {
  return session.questions.map(readAnswer);
}

function incompleteRequiredQuestions(questionList, answers) {
  const answersByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  return questionList.filter((question) => {
    if (!question.required) return false;
    const value = answersByQuestionId.get(question.id).value;
    if (question.type === 'multiple') return value.length === 0;
    if (question.type === 'single') return typeof value !== 'string' || value.trim() === '';
    return !value.trim();
  });
}

function displayAnswer(answer) {
  if (answer.value === null || answer.value === '') return 'No answer';
  if (Array.isArray(answer.value)) return answer.value.length === 0 ? 'No answer' : answer.value.join(', ');
  return answer.value;
}

// Flattens buildAnnotationsPayload() into a readable list for the review
// screen and Copy as JSON is the true recovery path for the actual result;
// this is here so a person can see, before submitting, that nothing they
// marked up is about to be silently dropped.
function annotationEntries() {
  const payload = buildAnnotationsPayload();
  const entries = [];
  for (const text of Object.values(payload.message ?? {})) entries.push({ label: 'Message', text });
  for (const [documentId, blocks] of Object.entries(payload.documents ?? {})) {
    const title = session.documents.find((item) => item.id === documentId)?.title ?? documentId;
    for (const text of Object.values(blocks)) entries.push({ label: `Document: ${title}`, text });
  }
  for (const [questionId, entry] of Object.entries(payload.questions ?? {})) {
    const question = session.questions.find((item) => item.id === questionId);
    const index = session.questions.indexOf(question);
    if (entry.prompt) entries.push({ label: `Question ${index + 1} prompt`, text: entry.prompt });
    for (const [optionValue, text] of Object.entries(entry.options ?? {})) {
      const option = question?.options?.find((item) => item.value === optionValue);
      entries.push({ label: `Question ${index + 1} option: ${option?.label ?? optionValue}`, text });
    }
  }
  return entries;
}

function renderReview() {
  reviewSummary.replaceChildren();
  copyStatus.hidden = true;
  const answers = readAnswers();
  const answersByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  session.questions.forEach((question, index) => {
    const answer = answersByQuestionId.get(question.id);
    const item = create('article', { className: 'review-item' });
    item.append(create('h3', { textContent: `Question ${index + 1}` }));
    item.append(create('p', { className: 'review-prompt', textContent: question.prompt }));
    const answerLabel = create('p', { className: 'review-label', textContent: 'Answer' });
    const answerValue = create('p', { className: 'review-value', textContent: displayAnswer(answer) });
    const notesLabel = create('p', { className: 'review-label', textContent: 'Notes' });
    const notesValue = create('p', { className: 'review-value', textContent: answer.notes || 'No notes' });
    item.append(answerLabel, answerValue, notesLabel, notesValue);
    reviewSummary.append(item);
  });
  const annotations = annotationEntries();
  if (annotations.length) {
    const section = create('section', { className: 'review-annotations' });
    section.append(create('h3', { textContent: 'Annotations' }));
    annotations.forEach(({ label, text }) => {
      const item = create('div', { className: 'review-annotation' });
      item.append(create('p', { className: 'review-label', textContent: label }));
      item.append(create('p', { className: 'review-value annotation-text', textContent: text }));
      section.append(item);
    });
    reviewSummary.append(section);
  }
}

function buildCopiedResult(answers) {
  return {
    version: 1,
    status: 'submitted',
    askerPath: session.askerPath,
    ...(session.askerTmuxWindow ? { askerTmuxWindow: session.askerTmuxWindow } : {}),
    answers: Object.fromEntries(answers.map(({ questionId, value, notes }) => [questionId, { value, notes }])),
    annotations: buildAnnotationsPayload(),
    submittedAt: new Date().toISOString(),
  };
}

async function copyPlainText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Use the plain-text fallback when Clipboard API access is unavailable.
  }
  const previousActiveElement = document.activeElement;
  const temporaryInput = create('textarea', { value });
  try {
    temporaryInput.setAttribute('aria-hidden', 'true');
    temporaryInput.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(temporaryInput);
    temporaryInput.select();
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('Clipboard access is unavailable.');
  } finally {
    temporaryInput.remove();
    if (previousActiveElement instanceof HTMLElement && previousActiveElement !== document.body && previousActiveElement.isConnected) previousActiveElement.focus();
    else copyJsonButton.focus();
  }
}

function answersForFinalAction() {
  const answers = readAnswers();
  const missingQuestions = incompleteRequiredQuestions(session.questions, answers);
  if (showRequiredQuestions(missingQuestions)) return answers;
  if (focused && reviewing) {
    reviewing = false;
    focusedQuestionIndex = session.questions.indexOf(missingQuestions[0]);
    updateQuestionView();
  }
  return undefined;
}

allQuestionsButton.addEventListener('click', () => {
  focused = false;
  reviewing = false;
  summary.hidden = true;
  updateQuestionView();
});
focusedQuestionButton.addEventListener('click', () => {
  focused = true;
  reviewing = false;
  summary.hidden = true;
  updateQuestionView();
});
previousQuestion.addEventListener('click', () => {
  summary.hidden = true;
  if (reviewing) reviewing = false;
  else if (focusedQuestionIndex > 0) focusedQuestionIndex -= 1;
  updateQuestionView();
});
nextQuestion.addEventListener('click', () => {
  summary.hidden = true;
  if (focusedQuestionIndex === session.questions.length - 1) {
    reviewing = true;
    renderReview();
  } else {
    focusedQuestionIndex += 1;
  }
  updateQuestionView();
});
updateQuestionView();

document.addEventListener('keydown', (event) => {
  if (!focused || form.hidden || event.repeat || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
  if (reviewing && submitButton.disabled) return;
  if (!reviewing && nextQuestion.disabled) return;
  event.preventDefault();
  if (reviewing) form.requestSubmit();
  else nextQuestion.click();
});

const documents = document.querySelector('#documents');
if (session.documents.length === 0) {
  const empty = create('div', { className: 'empty-documents' });
  empty.append(create('h2', { textContent: 'Supporting documents' }));
  empty.append(create('p', { textContent: 'No supporting documents were provided for this request.' }));
  documents.append(empty);
} else {
  documents.append(create('h2', { textContent: 'Supporting documents' }));
  const navigation = create('nav', { className: 'document-list', ariaLabel: 'Documents' });
  const content = create('article', { id: 'document-content', className: 'document-content' });
  const buttonsByDocumentId = new Map();
  const select = (id) => {
    const documentItem = session.documents.find((item) => item.id === id);
    if (!documentItem) return;
    attachDocument(content, documentItem);
    buttonsByDocumentId.forEach((button, documentId) => button.classList.toggle('active', documentId === id));
    content.scrollTop = 0;
  };
  session.documents.forEach((documentItem, index) => {
    const button = create('button', { type: 'button', textContent: documentItem.title });
    button.classList.toggle('active', index === 0);
    button.addEventListener('click', () => select(documentItem.id));
    buttonsByDocumentId.set(documentItem.id, button);
    navigation.append(button);
  });
  documents.append(navigation, content);
  select(session.documents[0].id);
}

function setBusy(action) {
  form.querySelectorAll('button, input, textarea').forEach((control) => { control.disabled = true; });
  submitButton.textContent = action === 'submit' ? 'Submitting…' : 'Submit answers';
  cancelButton.textContent = action === 'cancel' ? 'Cancelling…' : 'Cancel';
}

function clearBusy() {
  form.querySelectorAll('button, input, textarea').forEach((control) => { control.disabled = false; });
  otherValueSynchronisers.forEach((synchronise) => synchronise());
  submitButton.textContent = 'Submit answers';
  cancelButton.textContent = 'Cancel';
  updateQuestionView();
}

function showCompletion(title) {
  form.hidden = true;
  completion.hidden = false;
  document.querySelector('#completion-title').textContent = title;
  window.setTimeout(() => window.close(), 500);
}

async function completeRequest(path, body, action, successTitle) {
  setBusy(action);
  summary.hidden = true;
  try {
    const response = await fetch(path, body);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.issues?.map((item) => item.message).join(' ') || data.error || 'The local server did not accept the request.');
    }
    showCompletion(successTitle);
  } catch (error) {
    summary.textContent = `Could not ${action === 'submit' ? 'submit answers' : 'cancel'}: ${error.message}`;
    summary.hidden = false;
    clearBusy();
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const answers = answersForFinalAction();
  if (!answers) return;
  await completeRequest('api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, annotations: buildAnnotationsPayload() }),
  }, 'submit', 'Answers submitted. The agent can continue.');
});

copyJsonButton.addEventListener('click', async () => {
  const answers = answersForFinalAction();
  if (!answers) return;
  copyStatus.hidden = false;
  try {
    await copyPlainText(JSON.stringify(buildCopiedResult(answers)));
    copyStatus.textContent = 'Copied JSON. You can paste it into the agent session.';
  } catch (error) {
    copyStatus.textContent = `Could not copy JSON: ${error.message}`;
  }
});

cancelButton.addEventListener('click', async () => {
  await completeRequest('api/cancel', { method: 'POST' }, 'cancel', 'Cancelled. No answers were submitted.');
});
