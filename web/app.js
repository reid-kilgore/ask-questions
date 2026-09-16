import { attachDocument, attachMessage, attachOption, attachPrompt, buildAnnotationsPayload, isEditableTarget, listAnnotations, onAnnotationsChanged, openEditPopup, removeAnnotation, scrollToAnnotation } from './annotate.js';

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
const quizScoreEl = document.querySelector('#quiz-score');
const summary = document.querySelector('#summary');
const submitButton = form.querySelector('[type="submit"]');
const cancelButton = document.querySelector('#cancel');
const copyJsonButton = document.querySelector('#copy-json');
const copyQuizSummaryButton = document.querySelector('#copy-quiz-summary');
const copyStatus = document.querySelector('#copy-status');
const previousQuestion = document.querySelector('#previous-question');
const nextQuestion = document.querySelector('#next-question');
const completion = document.querySelector('#completion');
const contextScreen = document.querySelector('#context-screen');
const contextMessage = document.querySelector('#context-message');
const startQuestionsButton = document.querySelector('#start-questions');
const cardsByQuestionId = new Map();
const otherValueSynchronisers = [];
const quizState = new Map(); // questionId -> { value, correct, disagree }
let lastQuizSummaryText = '';

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

const hasContext = Boolean(session.messageHtml);
if (hasContext) contextScreen.hidden = false; // shown/hidden per-screen below; default visible until first render

// --- Screen model --------------------------------------------------------
// A flat, ordered list of screens: an optional context screen, one screen
// per question, then review. Both the rail and the prev/next footer walk
// this same list, so there is exactly one source of truth for "where am I".
const screens = [
  ...(hasContext ? [{ type: 'context' }] : []),
  ...session.questions.map((question, index) => ({ type: 'question', index })),
  { type: 'review' },
];
let currentScreen = 0;
const seenScreens = new Set();

function isAnswered(question, answer) {
  if (question.type === 'multiple') return answer.value.length > 0;
  if (question.type === 'text') return typeof answer.value === 'string' && answer.value.trim() !== '';
  return typeof answer.value === 'string' && answer.value.trim() !== '';
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

// --- Quiz question type ---------------------------------------------------

function renderQuizReveal(question, reveal, notesTextarea) {
  reveal.replaceChildren();
  reveal.hidden = false;
  const state = quizState.get(question.id);
  const correctOption = question.options.find((option) => option.value === question.answer);
  const verdict = create('p', { className: `quiz-verdict ${state.correct ? 'correct' : 'incorrect'}` });
  verdict.textContent = state.correct ? 'Correct.' : `Not quite — the spec says: ${correctOption?.label ?? question.answer}.`;
  reveal.append(verdict);
  if (question.why) reveal.append(create('p', { className: 'quiz-why', textContent: question.why }));
  if (question.cite) reveal.append(create('p', { className: 'quiz-cite', textContent: `“${question.cite}”` }));
  if (question.allowDisagree !== false) {
    const toggle = create('button', { type: 'button', className: 'quiz-disagree-toggle', textContent: 'I disagree with the spec here' });
    toggle.addEventListener('click', () => {
      state.disagree = !state.disagree;
      toggle.classList.toggle('active', state.disagree);
      toggle.textContent = state.disagree ? 'Disagreeing with the spec' : 'I disagree with the spec here';
      if (state.disagree) notesTextarea.focus();
      updateRail();
    });
    reveal.append(toggle);
  }
}

function renderQuizQuestion(card, question, questionIndex, notesTextarea) {
  const optionsEl = create('div', { className: 'options' });
  const reveal = create('div', { className: 'quiz-reveal', hidden: true });
  question.options.forEach((option) => {
    const button = create('button', { type: 'button', className: 'option quiz-option' });
    const content = create('span');
    content.append(create('strong', { textContent: option.label }));
    if (option.description) {
      const description = create('small');
      content.append(description);
      attachOption(description, question.id, option.value, option.description);
    }
    button.append(content);
    button.addEventListener('click', () => {
      if (quizState.has(question.id)) return;
      const correct = option.value === question.answer;
      quizState.set(question.id, { value: option.value, correct, disagree: false });
      [...optionsEl.children].forEach((otherButton, index) => {
        const candidate = question.options[index];
        otherButton.classList.add('locked');
        otherButton.disabled = true;
        if (candidate.value === question.answer) otherButton.classList.add('correct');
        else if (candidate.value === option.value) otherButton.classList.add('chosen-wrong');
      });
      renderQuizReveal(question, reveal, notesTextarea);
      updateRail();
    });
    optionsEl.append(button);
  });
  card.append(optionsEl, reveal);
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

  const notesLabel = create('label', { className: 'notes-label', textContent: 'Notes for the agent' });
  const notesTextarea = create('textarea', {
    className: 'notes',
    rows: 3,
    placeholder: question.type === 'quiz' ? 'Optional context — this is where an "I disagree" note goes too' : 'Optional context, rationale, or follow-up',
  });
  notesLabel.append(notesTextarea);

  if (question.type === 'text') {
    card.append(create('textarea', { className: 'answer', rows: 4, placeholder: question.placeholder || '' }));
  } else if (question.type === 'quiz') {
    renderQuizQuestion(card, question, questionIndex, notesTextarea);
  } else {
    const options = create('div', { className: 'options' });
    question.options.forEach((option, optionIndex) => addOption(options, question, option, questionIndex, optionIndex));
    card.append(options);
    if (question.allowOther) otherValueSynchronisers.push(addOtherOption(card, question, questionIndex));
  }

  card.append(notesLabel);
  questions.append(card);
});

function readAnswer(question) {
  const card = cardsByQuestionId.get(question.id);
  if (question.type === 'quiz') {
    const state = quizState.get(question.id);
    return { questionId: question.id, value: state?.value ?? null, notes: card.querySelector('.notes').value, disagree: state?.disagree ?? false };
  }
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
    if (question.type === 'single' || question.type === 'quiz') return typeof value !== 'string' || value.trim() === '';
    return !value.trim();
  });
}

function displayAnswer(question, answer) {
  if (question.type === 'quiz') {
    if (answer.value === null) return 'No answer';
    const state = quizState.get(question.id);
    const parts = [state?.correct ? 'Correct' : 'Incorrect'];
    if (state?.disagree) parts.push('disagreed');
    return parts.join(' · ');
  }
  if (answer.value === null || answer.value === '') return 'No answer';
  if (Array.isArray(answer.value)) return answer.value.length === 0 ? 'No answer' : answer.value.join(', ');
  return answer.value;
}

// Turns a structured annotation key (see web/annotate.js) into a label a
// person recognizes — shared between the review screen and the side
// panel, so the two never describe the same comment two different ways.
function describeKey(key) {
  const [scope, ...rest] = key;
  if (scope === 'message') return 'Context';
  if (scope === 'document') {
    const title = session.documents.find((item) => item.id === rest[0])?.title ?? rest[0];
    return `Document: ${title}`;
  }
  const question = session.questions.find((item) => item.id === rest[0]);
  const index = session.questions.indexOf(question);
  if (scope === 'prompt') return `Question ${index + 1} prompt`;
  const option = question?.options?.find((item) => item.value === rest[1]);
  return `Question ${index + 1} option: ${option?.label ?? rest[1]}`;
}

// Flattens buildAnnotationsPayload() into a readable list for the review
// screen and Copy as JSON is the true recovery path for the actual result;
// this is here so a person can see, before submitting, that nothing they
// marked up is about to be silently dropped.
function annotationEntries() {
  const payload = buildAnnotationsPayload();
  const entries = [];
  for (const text of Object.values(payload.message ?? {})) entries.push({ label: describeKey(['message']), text });
  for (const [documentId, blocks] of Object.entries(payload.documents ?? {})) {
    for (const text of Object.values(blocks)) entries.push({ label: describeKey(['document', documentId]), text });
  }
  for (const [questionId, entry] of Object.entries(payload.questions ?? {})) {
    if (entry.prompt) entries.push({ label: describeKey(['prompt', questionId]), text: entry.prompt });
    for (const [optionValue, text] of Object.entries(entry.options ?? {})) {
      entries.push({ label: describeKey(['option', questionId, optionValue]), text });
    }
  }
  return entries;
}

function hasQuizQuestions() {
  return session.questions.some((question) => question.type === 'quiz');
}

function quizScoreData(answers) {
  const quizAnswers = session.questions
    .filter((question) => question.type === 'quiz')
    .map((question) => {
      const answer = answers.find((item) => item.questionId === question.id);
      const state = quizState.get(question.id);
      return { question, value: answer.value, correct: answer.value === question.answer, disagree: state?.disagree ?? false, notes: answer.notes };
    });
  const right = quizAnswers.filter((item) => item.correct).length;
  const disagree = quizAnswers.filter((item) => item.disagree).length;
  return { quizAnswers, right, wrong: quizAnswers.length - right, disagree, total: quizAnswers.length };
}

function renderQuizScore(answers) {
  if (!hasQuizQuestions()) { quizScoreEl.hidden = true; lastQuizSummaryText = ''; return; }
  quizScoreEl.hidden = false;
  quizScoreEl.replaceChildren();
  const { quizAnswers, right, wrong, disagree, total } = quizScoreData(answers);
  quizScoreEl.append(create('p', { className: 'quiz-score-line', textContent: `Quiz score: ${right}/${total} correct, ${wrong} wrong, ${disagree} disagreed` }));
  const lines = [`Quiz results — ${right}/${total} correct, ${wrong} wrong, ${disagree} disagreed`, ''];
  const problems = quizAnswers.filter((item) => !item.correct || item.disagree);
  if (problems.length === 0) {
    const okLine = 'Everything matched the spec and nothing was disagreed with.';
    quizScoreEl.append(create('p', { textContent: okLine }));
    lines.push(okLine);
  } else {
    problems.forEach(({ question, value, correct, disagree: disagreed, notes }) => {
      const yourAnswer = question.options.find((option) => option.value === value)?.label ?? 'No answer';
      const specAnswer = question.options.find((option) => option.value === question.answer)?.label ?? question.answer;
      const summaryLine = `Your answer: ${yourAnswer}${correct ? '' : ` — spec: ${specAnswer}`}${disagreed ? ' (disagreed)' : ''}`;
      const block = create('div', { className: 'quiz-score-block' });
      block.append(create('p', { textContent: question.prompt }));
      block.append(create('p', { textContent: summaryLine }));
      if (notes) block.append(create('p', { textContent: `Note: ${notes}` }));
      quizScoreEl.append(block);
      lines.push(question.prompt, summaryLine);
      if (notes) lines.push(`Note: ${notes}`);
      lines.push('');
    });
  }
  lastQuizSummaryText = lines.join('\n').trim();
  const textBlock = create('textarea', {
    className: 'quiz-score-text',
    readOnly: true,
    rows: Math.min(18, lines.length + 2),
    value: lastQuizSummaryText,
  });
  quizScoreEl.append(textBlock);
}

function renderReview() {
  reviewSummary.replaceChildren();
  copyStatus.hidden = true;
  const answers = readAnswers();
  const answersByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  renderQuizScore(answers);
  session.questions.forEach((question, index) => {
    const answer = answersByQuestionId.get(question.id);
    const item = create('article', { className: 'review-item' });
    item.append(create('h3', { textContent: `Question ${index + 1}` }));
    item.append(create('p', { className: 'review-prompt', textContent: question.prompt }));
    const answerLabel = create('p', { className: 'review-label', textContent: 'Answer' });
    const answerValue = create('p', { className: 'review-value', textContent: displayAnswer(question, answer) });
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
    answers: Object.fromEntries(answers.map(({ questionId, value, notes, disagree }) => {
      const question = session.questions.find((item) => item.id === questionId);
      if (question.type === 'quiz') return [questionId, { value, notes, correct: value === question.answer, answer: question.answer, disagree: disagree ?? false }];
      return [questionId, { value, notes }];
    })),
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
  if (screens[currentScreen].type === 'review') {
    const target = screens.findIndex((screenItem) => screenItem.type === 'question' && session.questions[screenItem.index].id === missingQuestions[0].id);
    if (target !== -1) goToScreen(target);
  }
  return undefined;
}

function showRequiredQuestions(requiredQuestions) {
  if (requiredQuestions.length === 0) return true;
  summary.textContent = `Complete required questions: ${requiredQuestions.map((question) => question.prompt).join('; ')}`;
  summary.hidden = false;
  return false;
}

// --- Screen navigation, rail, footer --------------------------------------

const rail = document.querySelector('#rail');
const railItems = document.querySelector('#rail-items');

function railMark(descriptor, index) {
  if (descriptor.type === 'context') return '0';
  if (descriptor.type === 'review') return 'R';
  return String(descriptor.index + 1);
}

function railTitle(descriptor) {
  if (descriptor.type === 'context') return 'Context';
  if (descriptor.type === 'review') return 'Review';
  const question = session.questions[descriptor.index];
  return question.prompt.length > 40 ? `${question.prompt.slice(0, 37)}…` : question.prompt;
}

function questionRailState(question) {
  const seen = seenScreens.has(question.id);
  const answer = readAnswer(question);
  if (question.type === 'quiz') {
    const state = quizState.get(question.id);
    if (state) {
      if (state.disagree) return 'amber';
      return state.correct ? 'answered' : 'wrong';
    }
  } else if (isAnswered(question, answer)) {
    return 'answered';
  }
  if (seen && question.required) return 'skipped-required';
  if (seen) return 'seen';
  return 'todo';
}

function railState(descriptor, index) {
  if (index === currentScreen) return 'current';
  if (descriptor.type === 'context') return seenScreens.has('context') ? 'seen' : 'todo';
  if (descriptor.type === 'review') return seenScreens.has('review') ? 'seen' : 'todo';
  return questionRailState(session.questions[descriptor.index]);
}

function railStatusLine(descriptor) {
  if (descriptor.type === 'context') return seenScreens.has('context') ? 'Read' : 'Not read yet';
  if (descriptor.type === 'review') return 'Final step';
  const question = session.questions[descriptor.index];
  const state = questionRailState(question);
  return { current: 'Current', answered: 'Answered', wrong: 'Answered — incorrect', amber: 'Disagreed', 'skipped-required': 'Required — not answered', seen: 'Seen', todo: 'Not seen' }[state] ?? '';
}

let railButtons = [];
function buildRail() {
  railItems.replaceChildren();
  railButtons = screens.map((descriptor, index) => {
    const button = create('button', { type: 'button', className: 'rail-item' });
    const mark = create('span', { className: 'rail-mark', textContent: railMark(descriptor, index) });
    const detail = create('span', { className: 'rail-detail' });
    detail.append(create('span', { className: 'rail-title', textContent: railTitle(descriptor) }));
    detail.append(create('span', { className: 'rail-status' }));
    button.append(mark, detail);
    button.addEventListener('click', () => goToScreen(index));
    railItems.append(button);
    return button;
  });
  rail.hidden = session.questions.length <= 1;
}

function updateRail() {
  screens.forEach((descriptor, index) => {
    const button = railButtons[index];
    const state = railState(descriptor, index);
    button.className = `rail-item state-${state}`;
    button.querySelector('.rail-status').textContent = railStatusLine(descriptor);
  });
}

function updateFooter() {
  const descriptor = screens[currentScreen];
  const isContext = descriptor.type === 'context';
  const isReview = descriptor.type === 'review';
  previousQuestion.hidden = currentScreen === 0;
  previousQuestion.disabled = currentScreen === 0;
  nextQuestion.hidden = isContext || isReview;
  if (!isContext && !isReview) nextQuestion.textContent = descriptor.index === session.questions.length - 1 ? 'Review answers' : 'Next';
  submitButton.hidden = !isReview;
  copyJsonButton.hidden = !isReview;
  copyQuizSummaryButton.hidden = !isReview || !hasQuizQuestions();
}

function updateView() {
  const descriptor = screens[currentScreen];
  contextScreen.hidden = descriptor.type !== 'context';
  questions.hidden = descriptor.type !== 'question';
  review.hidden = descriptor.type !== 'review';
  if (descriptor.type === 'question') {
    session.questions.forEach((question, index) => {
      cardsByQuestionId.get(question.id).hidden = index !== descriptor.index;
    });
  }
  if (descriptor.type === 'review') renderReview();
  updateFooter();
  renderDocumentsPane();
  updateRail();
}

function goToScreen(index) {
  if (index < 0 || index >= screens.length) return;
  summary.hidden = true;
  currentScreen = index;
  const descriptor = screens[index];
  seenScreens.add(descriptor.type === 'question' ? session.questions[descriptor.index].id : descriptor.type);
  updateView();
}

buildRail();

startQuestionsButton.textContent = session.questions.length === 1 ? 'Go to the question' : 'Start with question 1';
startQuestionsButton.addEventListener('click', () => goToScreen(hasContext ? 1 : 0));

previousQuestion.addEventListener('click', () => goToScreen(currentScreen - 1));
nextQuestion.addEventListener('click', () => goToScreen(currentScreen + 1));

function selectNthOption(n) {
  const descriptor = screens[currentScreen];
  if (descriptor.type !== 'question') return;
  const question = session.questions[descriptor.index];
  if (question.type === 'text') return;
  const card = cardsByQuestionId.get(question.id);
  if (question.type === 'quiz') {
    const buttons = [...card.querySelectorAll('.quiz-option')];
    buttons[n]?.click();
  } else {
    const inputs = [...card.querySelectorAll('.option input')];
    inputs[n]?.click();
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return;
  }
  if (isEditableTarget(document.activeElement)) return;
  if (event.metaKey || event.ctrlKey) {
    if (event.repeat) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const descriptor = screens[currentScreen];
      if (descriptor.type === 'review') { if (!submitButton.disabled) form.requestSubmit(); }
      else if (descriptor.type === 'context') startQuestionsButton.click();
      else if (!nextQuestion.hidden) nextQuestion.click();
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      goToScreen(currentScreen - 1);
    } else if (event.key === '0') {
      event.preventDefault();
      if (hasContext) goToScreen(0);
    }
    return;
  }
  if (/^[1-9]$/.test(event.key)) selectNthOption(Number(event.key) - 1);
});

// --- Documents pane (Context tab + supporting documents) -------------------

const documentsPane = document.querySelector('#documents-pane');
const documentsToggle = document.querySelector('#documents-toggle');
const documentsResizer = document.querySelector('#documents-pane-resizer');
const documentsContainer = document.querySelector('#documents');
const paneWidthKey = `askq-docpane-width:${session.askerPath}`;
let docPaneWidth = Number(localStorage.getItem(paneWidthKey)) || 360;
// Narrow/mobile layout stacks the documents pane under the questions pane
// (see the max-width: 800px block in style.css) — default it collapsed
// there so it doesn't permanently eat ~45vh of a phone-sized screen. Still
// user-togglable afterward via the existing #documents-toggle button.
let docPaneOpen = window.innerWidth > 800;
let activeDocTabId = hasContext ? 'context' : (session.documents[0]?.id ?? null);

function applyDocPaneWidth() {
  documentsPane.style.width = docPaneOpen ? `${Math.min(Math.max(docPaneWidth, 260), 720)}px` : '34px';
  // .documents-pane.collapsed is what actually hides the pane at mobile
  // widths (see style.css) — the mobile layout forces width:auto so the
  // inline 34px/open-width style above has no effect there on its own.
  documentsPane.classList.toggle('collapsed', !docPaneOpen);
  documentsToggle.ariaExpanded = String(docPaneOpen);
}

documentsToggle.addEventListener('click', () => {
  docPaneOpen = !docPaneOpen;
  applyDocPaneWidth();
});

documentsResizer.addEventListener('mousedown', (event) => {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = documentsPane.getBoundingClientRect().width;
  const onMove = (moveEvent) => {
    const width = Math.min(720, Math.max(34, startWidth - (moveEvent.clientX - startX)));
    docPaneOpen = width > 34;
    docPaneWidth = Math.max(width, 260);
    documentsPane.style.width = `${Math.max(width, 34)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    localStorage.setItem(paneWidthKey, String(docPaneWidth));
    applyDocPaneWidth();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

function renderDocumentsPane() {
  const onContextScreen = screens[currentScreen].type === 'context';
  const tabs = [
    ...(hasContext && !onContextScreen ? [{ id: 'context', title: 'Context' }] : []),
    ...session.documents.map((documentItem) => ({ id: documentItem.id, title: documentItem.title })),
  ];
  if (tabs.length === 0) {
    documentsPane.hidden = true;
    documentsToggle.hidden = true;
    return;
  }
  documentsToggle.hidden = false;
  documentsPane.hidden = false;
  applyDocPaneWidth();
  if (!tabs.some((tab) => tab.id === activeDocTabId)) activeDocTabId = tabs[0].id;

  documentsContainer.replaceChildren();
  const navigation = create('nav', { className: 'document-list', ariaLabel: 'Documents' });
  const content = create('article', { id: 'document-content', className: 'document-content' });
  const buttons = new Map();
  const select = (id) => {
    activeDocTabId = id;
    if (id === 'context') attachMessage(content, session.messageHtml, session.messageBlockText);
    else attachDocument(content, session.documents.find((item) => item.id === id));
    buttons.forEach((button, tabId) => button.classList.toggle('active', tabId === id));
    content.scrollTop = 0;
  };
  tabs.forEach((tab) => {
    const button = create('button', { type: 'button', textContent: tab.title });
    button.addEventListener('click', () => select(tab.id));
    buttons.set(tab.id, button);
    navigation.append(button);
  });
  documentsContainer.append(navigation, content);
  select(activeDocTabId);
  selectDocument = (id) => { if (tabs.some((tab) => tab.id === id)) select(id); };
}

// Reassigned above; jumpToAnnotation() needs a way to switch tabs regardless
// of which document/context tab is currently selected.
let selectDocument = () => {};

// Render the context screen's own copy of the message (separate DOM node
// from the documents-pane Context tab — attachMessage only ever targets
// whichever one is visible, see renderDocumentsPane above).
if (hasContext) attachMessage(contextMessage, session.messageHtml, session.messageBlockText);

goToScreen(currentScreen); // re-run now that renderDocumentsPane/selectDocument exist

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
  updateView();
}

function showCompletion(title) {
  form.hidden = true;
  contextScreen.hidden = true;
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

copyQuizSummaryButton.addEventListener('click', async () => {
  copyStatus.hidden = false;
  try {
    await copyPlainText(lastQuizSummaryText);
    copyStatus.textContent = 'Copied quiz summary.';
  } catch (error) {
    copyStatus.textContent = `Could not copy quiz summary: ${error.message}`;
  }
});

cancelButton.addEventListener('click', async () => {
  await completeRequest('api/cancel', { method: 'POST' }, 'cancel', 'Cancelled. No answers were submitted.');
});

// --- Comments panel -----------------------------
//
// Reviewing and managing comments already made — jump to one, remove it,
// edit it. Creating a new one stays where the eye already is (select text,
// or focus a block, and press Cmd/Ctrl+E — see web/annotate.js), not here.

const annotationPanel = document.querySelector('#annotation-panel');
const annotationPanelToggle = document.querySelector('#annotation-panel-toggle');
const annotationPanelClose = document.querySelector('#annotation-panel-close');
const annotationPanelList = document.querySelector('#annotation-panel-list');
const annotationCount = document.querySelector('#annotation-count');

function setPanelOpen(open) {
  annotationPanel.classList.toggle('open', open);
  annotationPanelToggle.ariaExpanded = String(open);
  if (open) renderAnnotationPanel();
}

function jumpToAnnotation(entry) {
  const [scope] = entry.key;
  if (scope === 'document') { selectDocument(entry.key[1]); }
  else if (scope === 'message') { if (screens[currentScreen].type !== 'context') selectDocument('context'); }
  else if (scope === 'prompt' || scope === 'option') {
    const question = session.questions.find((item) => item.id === entry.key[1]);
    const target = screens.findIndex((screenItem) => screenItem.type === 'question' && session.questions[screenItem.index].id === question?.id);
    if (target !== -1) goToScreen(target);
  }
  setPanelOpen(false);
  // The view switch above can replace the DOM the mark lives in; wait a
  // frame so scrollToAnnotation finds the freshly rendered element.
  requestAnimationFrame(() => scrollToAnnotation(entry.key, entry.index));
}

function renderAnnotationPanel() {
  const entries = listAnnotations();
  annotationCount.textContent = String(entries.length);
  annotationPanelList.replaceChildren();
  if (entries.length === 0) {
    annotationPanelList.append(create('p', { className: 'annotation-panel-empty', textContent: 'No comments yet. Select text (or focus a block) and press Cmd/Ctrl+E to add one.' }));
    return;
  }
  entries.forEach((entry) => {
    const item = create('article', { className: 'annotation-entry' });
    item.append(create('p', { className: 'annotation-entry-location', textContent: describeKey(entry.key) }));
    item.append(create('p', { className: 'annotation-entry-highlight', textContent: `"${entry.highlight}"` }));
    item.append(create('p', { className: 'annotation-entry-comment', textContent: entry.comment }));
    const actions = create('div', { className: 'annotation-entry-actions' });
    const jumpButton = create('button', { type: 'button', textContent: 'Jump to' });
    jumpButton.addEventListener('click', () => jumpToAnnotation(entry));
    const editButton = create('button', { type: 'button', textContent: 'Edit' });
    editButton.addEventListener('click', () => {
      if (entry.key[0] === 'document') selectDocument(entry.key[1]);
      else if (entry.key[0] === 'message') { if (screens[currentScreen].type !== 'context') selectDocument('context'); }
      else if (entry.key[0] === 'prompt' || entry.key[0] === 'option') {
        const question = session.questions.find((item) => item.id === entry.key[1]);
        const target = screens.findIndex((screenItem) => screenItem.type === 'question' && session.questions[screenItem.index].id === question?.id);
        if (target !== -1) goToScreen(target);
      }
      setPanelOpen(false);
      requestAnimationFrame(() => openEditPopup(entry.key, entry.index));
    });
    const removeButton = create('button', { type: 'button', textContent: 'Remove' });
    removeButton.addEventListener('click', () => removeAnnotation(entry.key, entry.index));
    actions.append(jumpButton, editButton, removeButton);
    item.append(actions);
    annotationPanelList.append(item);
  });
}

annotationPanelToggle.addEventListener('click', () => setPanelOpen(!annotationPanel.classList.contains('open')));
annotationPanelClose.addEventListener('click', () => setPanelOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && annotationPanel.classList.contains('open')) setPanelOpen(false);
});
onAnnotationsChanged(() => {
  annotationCount.textContent = String(listAnnotations().length);
  if (annotationPanel.classList.contains('open')) renderAnnotationPanel();
});
