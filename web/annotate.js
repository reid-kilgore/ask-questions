// Lets a person mark up the text they are reading — documents, the message,
// question prompts, and option descriptions — with a CriticMarkup comment,
// block level. See README.md for the shape this produces; this module only
// builds that shape and drives the DOM, it does not know about
// submit/cancel/review at all — app.js owns that.
//
// Every annotation carries a comment; there is no highlight-only action.
// Creating one is Cmd/Ctrl+E — on a selection, or on a focused block with
// no selection for a whole-block comment — rather than a toolbar that pops
// up on selection. See the shortcut section below for why, and for the
// one browser default it has to fight.
//
// Anchoring is against plain text the server already sent (`blockText` for
// documents/message, and the prompt/option strings themselves, which never
// pass through the renderer). This module never re-derives or second
// -guesses that text — see verifySurface() for the one place it checks its
// own DOM against it, which exists purely to fail an individual block safe
// (skip it) rather than annotate against text that has silently drifted.
import { insertAnnotation } from './vendor/criticmarkup.js';

// keyString/target: every annotatable thing has a small array key —
// ['message', blockId], ['document', documentId, blockId],
// ['prompt', questionId], or ['option', questionId, optionValue] — turned
// into a string for Map lookups and back out when building the result.
const keyString = (key) => JSON.stringify(key);

// targets: keyString -> { key, text, container, reset }. `text` is the
// original plain text this key annotates; `reset` rebuilds `container`
// (and every other target sharing it) from that original text plus every
// currently stored range, discarding whatever marks were on screen before.
// Always fully rebuilding, rather than patching one <mark> in or out, is
// what keeps add/remove free of incremental-DOM edge cases.
const targets = new Map();

// blockElements: keyString -> the specific element that carries this key's
// marks (as opposed to `container`, which for a document/message key is
// the whole document/message pane). Used only to locate a key's own marks
// in the DOM — for the side panel's "jump to" and "edit", and nowhere else.
const blockElements = new Map();

// store: keyString -> [{ start, end, comment }], offsets against `text`.
const store = new Map();

// Anyone (app.js's side panel) who wants to know when an annotation is
// added, edited, or removed — from any of the paths below — subscribes
// here, rather than this module reaching into app.js to re-render anything
// itself; see the module comment on why this stays a one-way boundary.
const changeListeners = new Set();
export function onAnnotationsChanged(callback) {
  changeListeners.add(callback);
  return () => changeListeners.delete(callback);
}
function notifyChanged() {
  changeListeners.forEach((callback) => callback());
}

function addRange(key, start, end, comment) {
  if (start >= end) return { ok: false, reason: 'Select some text first.' };
  const ranges = store.get(keyString(key)) ?? [];
  if (ranges.some((range) => start < range.end && range.start < end)) {
    return { ok: false, reason: 'That text already has a comment.' };
  }
  store.set(keyString(key), [...ranges, { start, end, comment }]);
  return { ok: true };
}

function updateRangeComment(key, index, comment) {
  const ranges = store.get(keyString(key)) ?? [];
  if (index < 0 || index >= ranges.length) return { ok: false, reason: 'That comment no longer exists.' };
  const next = ranges.slice();
  next[index] = { ...next[index], comment };
  store.set(keyString(key), next);
  return { ok: true };
}

function removeRange(key, index) {
  const ranges = store.get(keyString(key)) ?? [];
  const next = ranges.filter((_range, rangeIndex) => rangeIndex !== index);
  if (next.length) store.set(keyString(key), next);
  else store.delete(keyString(key));
}

/**
 * CriticMarkup has no escape mechanism (see the criticmarkup README): a
 * highlight body ends at the first literal `==}` that follows it. Text
 * containing that exact sequence would produce markup that looks valid but
 * does not round-trip — the server's own `clearAnnotations` check (which is
 * correct, and stays exactly as it is) would then reject the whole submit
 * request, with no indication of which mark caused it. Refusing at
 * creation time, with a reason the person can act on, is the fix.
 *
 * Pure and DOM-free on purpose, so it is directly testable without a
 * browser.
 *
 * @param {string} highlightText
 * @returns {string|null} A reason the highlight cannot be created, or null if it is safe.
 */
export function unsafeHighlightReason(highlightText) {
  if (highlightText.includes('==}')) {
    return 'That text contains "==}", which CriticMarkup cannot highlight — it has no way to escape it. Select a shorter or different range.';
  }
  return null;
}

/**
 * Same idea as {@link unsafeHighlightReason}, for the comment body's own
 * terminator (`<<}`).
 *
 * @param {string} comment
 * @returns {string|null}
 */
export function unsafeCommentReason(comment) {
  if (comment.includes('<<}')) {
    return 'That comment contains "<<}", which CriticMarkup cannot store — it has no way to escape it. Remove that and try again.';
  }
  return null;
}

// --- Plain-text offsets <-> DOM positions -----------------------------
//
// Range.toString() serializes exactly the text nodes a Range spans, the
// same left-to-right, no-separator concatenation `element.textContent`
// uses — so measuring a boundary's offset is just the length of a range
// from the container's start up to that boundary, with no manual
// TreeWalker bookkeeping needed for the forward direction.

function offsetInRoot(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

// The reverse direction (offset -> DOM position) does need a walk, since
// there is no built-in "give me the Nth character" API.
function domPositionAt(root, target) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let node = walker.nextNode();
  let last = null;
  while (node) {
    const length = node.nodeValue.length;
    if (total + length >= target) return { node, offset: target - total };
    total += length;
    last = node;
    node = walker.nextNode();
  }
  return last ? { node: last, offset: last.nodeValue.length } : { node: root, offset: 0 };
}

// Wrapping never changes any text node's character count, so re-deriving
// each mark's DOM position fresh against the current (already partly
// -marked) DOM is always correct — order between marks does not matter,
// unlike the string-splicing in assembleAnnotations() below.
function wrapRange(root, start, end, comment, index) {
  if (start === end) return;
  const startPosition = domPositionAt(root, start);
  const endPosition = domPositionAt(root, end);
  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  const mark = document.createElement('mark');
  mark.className = 'annotation-mark';
  mark.tabIndex = 0;
  mark.dataset.annotationIndex = String(index);
  mark.title = comment;
  // extractContents() (unlike Range.surroundContents()) splits ancestor
  // elements as needed, so a highlight crossing an inline boundary (e.g.
  // "some *emphasis* text") does not throw.
  mark.append(range.extractContents());
  range.insertNode(mark);
}

function renderRanges(root, key) {
  const ranges = store.get(keyString(key)) ?? [];
  ranges.forEach((range, index) => wrapRange(root, range.start, range.end, range.comment, index));
}

// --- Registering annotatable elements -----------------------------

function registerTarget(el, key, text, container, reset) {
  targets.set(keyString(key), { key, text, container, reset });
  blockElements.set(keyString(key), el);
  el.tabIndex = 0;
  el.classList.add('annotatable');
}

// Verified at hydrate time against the plain text the server sent, so a
// block only becomes annotatable once the browser's own reading of it
// agrees. This is the runtime side of "the server owns the plain text":
// it converts what would otherwise be a claim proven once at build time
// into a check that fails safe, per block, every time a page loads.
function verifySurface(el, expectedText) {
  return el.textContent === expectedText;
}

// A container and its only child can share a source line range — a
// blockquote wrapping a single paragraph, for instance (see
// lib/blockAnchor.js and its tests) — which means both elements carry the
// same `data-block` id. Registering and rendering both would wrap the same
// stored range twice: a mark nested inside a mark, and a duplicate Tab
// stop. Keeping only the first element for each id (outer before inner, in
// document order) fixes both. The scan itself is a pure function of the id
// sequence, kept separate from the DOM walk below so it can be tested
// without a browser.
//
// This must run only over ids that already passed verifySurface, not the
// raw element list: a container's own textContent routinely differs from
// its single child's, because markdown-it's HTML output puts a literal
// newline between block tags for readability (e.g.
// "<blockquote>\n<p>...</p>\n</blockquote>") — that whitespace is part of
// the blockquote's textContent but not of blockText[id]. Deduplicating
// before verifying would let a failed outer element silently take the slot
// away from its inner element, which does verify — losing the block
// entirely instead of falling back to the one that actually matches.
export function firstOccurrenceOnly(ids) {
  const seen = new Set();
  return ids.map((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function hydrateBlocks(container, blockText, keyPrefix, reset) {
  if (!blockText) return;
  const candidates = [...container.querySelectorAll('[data-block]')]
    .map((el) => ({ el, blockId: el.dataset.block, text: blockText[el.dataset.block] }))
    // A wrapper with no text of its own (see lib/blockAnchor.js) has no
    // blockText entry at all; verifySurface fails a block safe (leaves it
    // non-annotatable) rather than throwing, for the same reason.
    .filter((candidate) => candidate.text !== undefined && verifySurface(candidate.el, candidate.text));
  const keep = firstOccurrenceOnly(candidates.map((candidate) => candidate.blockId));
  candidates.forEach((candidate, index) => {
    if (!keep[index]) return;
    const key = [...keyPrefix, candidate.blockId];
    registerTarget(candidate.el, key, candidate.text, container, reset);
    renderRanges(candidate.el, key);
  });
}

export function attachMessage(el, html, blockText) {
  const reset = () => {
    el.innerHTML = html;
    hydrateBlocks(el, blockText, ['message'], reset);
  };
  el.dataset.annotateScope = 'message';
  reset();
}

export function attachDocument(el, documentItem) {
  const reset = () => {
    el.innerHTML = documentItem.html;
    hydrateBlocks(el, documentItem.blockText, ['document', documentItem.id], reset);
  };
  el.dataset.annotateScope = 'document';
  el.dataset.annotateDocument = documentItem.id;
  reset();
}

export function attachPrompt(el, questionId, text) {
  const key = ['prompt', questionId];
  const reset = () => {
    el.textContent = text;
    registerTarget(el, key, text, el, reset);
    renderRanges(el, key);
  };
  el.dataset.annotateScope = 'prompt';
  el.dataset.questionId = questionId;
  reset();
}

export function attachOption(el, questionId, optionValue, text) {
  const key = ['option', questionId, optionValue];
  const reset = () => {
    el.textContent = text;
    registerTarget(el, key, text, el, reset);
    renderRanges(el, key);
  };
  el.dataset.annotateScope = 'option';
  el.dataset.questionId = questionId;
  el.dataset.optionValue = optionValue;
  reset();
}

// --- Resolving an interaction back to a target -----------------------------

function resolveTarget(node) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!(el instanceof Element)) return null;
  const scopeEl = el.closest('[data-annotate-scope]');
  if (!scopeEl) return null;
  const scope = scopeEl.dataset.annotateScope;
  if (scope === 'message' || scope === 'document') {
    const blockEl = el.closest('[data-block]');
    if (!blockEl || !scopeEl.contains(blockEl)) return null;
    const key = scope === 'message' ? ['message', blockEl.dataset.block] : ['document', scopeEl.dataset.annotateDocument, blockEl.dataset.block];
    const target = targets.get(keyString(key));
    return target ? { key, root: blockEl } : null;
  }
  const key = scope === 'prompt' ? ['prompt', scopeEl.dataset.questionId] : ['option', scopeEl.dataset.questionId, scopeEl.dataset.optionValue];
  const target = targets.get(keyString(key));
  return target ? { key, root: scopeEl } : null;
}

// --- The comment popup -----------------------------
//
// One small popup, not a toolbar: there is only one action (write a
// comment), so there is nothing to choose between. Declared with `let` and
// built only when `document` exists, so this module — and the pure,
// DOM-free functions above — stay importable and testable under plain
// Node, with no browser and no new dependency. Nothing here changes what
// runs in an actual browser: `document` always exists there, so this block
// always runs, exactly as before.
let popup, commentInput, popupStatus;

if (typeof document !== 'undefined') {
  popup = document.createElement('div');
  popup.className = 'annotation-popup';
  popup.hidden = true;
  commentInput = Object.assign(document.createElement('textarea'), { rows: 2, placeholder: 'Comment on this text' });
  const hint = document.createElement('div');
  hint.className = 'annotation-popup-hint';
  hint.textContent = '⌘/Ctrl + Enter to save · Esc to cancel';
  popupStatus = document.createElement('div');
  popupStatus.className = 'annotation-status';
  popupStatus.setAttribute('role', 'status');
  popup.append(commentInput, hint, popupStatus);
  document.body.append(popup);
}

// pending: what the open popup is acting on.
//   { mode: 'create', key, start, end }
//   { mode: 'edit', key, index }
let pending = null;

function place(rect) {
  popup.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  popup.style.top = `${Math.max(8, rect.top + window.scrollY - popup.offsetHeight - 8)}px`;
}

function hidePopup() {
  pending = null;
  popup.hidden = true;
  commentInput.value = '';
  popupStatus.textContent = '';
}

function openCreatePopup(key, start, end, rect) {
  pending = { mode: 'create', key, start, end };
  commentInput.value = '';
  popupStatus.textContent = '';
  popup.hidden = false;
  place(rect);
  commentInput.focus();
}

/**
 * Opens the same popup pre-filled with an existing comment — for the side
 * panel's edit action, and for clicking directly on a mark. Positions near
 * the comment's own mark when it is currently rendered (it may not be —
 * the panel can list a comment on a document that is not the one
 * currently selected — in which case it falls back to the block/prompt
 * /option element itself).
 *
 * @param {string[]} key
 * @param {number} index
 * @returns {boolean} Whether a popup was actually opened.
 */
export function openEditPopup(key, index) {
  const keyStr = keyString(key);
  const ranges = store.get(keyStr) ?? [];
  const range = ranges[index];
  if (!range) return false;
  const el = blockElements.get(keyStr);
  const mark = el?.querySelector(`mark.annotation-mark[data-annotation-index="${index}"]`);
  const rect = (mark ?? el)?.getBoundingClientRect();
  pending = { mode: 'edit', key, index };
  commentInput.value = range.comment ?? '';
  popupStatus.textContent = '';
  popup.hidden = false;
  if (rect) place(rect);
  commentInput.focus();
  return true;
}

function save() {
  if (!pending) return;
  const comment = commentInput.value.trim();
  if (comment === '') {
    popupStatus.textContent = 'Add a comment before saving.';
    return;
  }
  const commentReason = unsafeCommentReason(comment);
  if (commentReason) {
    popupStatus.textContent = commentReason;
    return;
  }
  if (pending.mode === 'create') {
    const { key, start, end } = pending;
    const highlightText = targets.get(keyString(key)).text.slice(start, end);
    const highlightReason = unsafeHighlightReason(highlightText);
    if (highlightReason) {
      popupStatus.textContent = highlightReason;
      return;
    }
    const outcome = addRange(key, start, end, comment);
    if (!outcome.ok) {
      popupStatus.textContent = outcome.reason;
      return;
    }
    targets.get(keyString(key)).reset();
    window.getSelection()?.removeAllRanges();
  } else {
    const outcome = updateRangeComment(pending.key, pending.index, comment);
    if (!outcome.ok) {
      popupStatus.textContent = outcome.reason;
      return;
    }
    targets.get(keyString(pending.key))?.reset();
  }
  hidePopup();
  notifyChanged();
}

// --- The Cmd/Ctrl+E shortcut -----------------------------
//
// Cmd+E, not a two-key sequence: the person asked for it directly, to
// match their own editor binding. Cmd+E is not a character anyone types,
// so it does not carry the "don't eat a keystroke out of someone's prose"
// hazard the comma-based chord did — but isEditableTarget still earns its
// place for two narrower reasons: (1) it stops a second popup from
// stacking on top of itself when Cmd+E is pressed while the comment field
// already has focus, and (2) it keeps behaviour sane inside an ordinary
// answer field — without it, a stale `window.getSelection()` left over
// from selecting text elsewhere on the page could otherwise resolve to a
// valid annotation target even while someone is just typing an answer.
export function isEditableTarget(target) {
  if (!target) return false;
  return target.isContentEditable === true || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT';
}

function annotateFromShortcut() {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const startTarget = resolveTarget(range.startContainer);
    const endTarget = resolveTarget(range.endContainer);
    if (startTarget && endTarget && keyString(startTarget.key) === keyString(endTarget.key)) {
      const start = offsetInRoot(startTarget.root, range.startContainer, range.startOffset);
      const end = offsetInRoot(startTarget.root, range.endContainer, range.endOffset);
      if (start !== null && end !== null) {
        const [lo, hi] = start <= end ? [start, end] : [end, start];
        if (lo !== hi) {
          openCreatePopup(startTarget.key, lo, hi, range.getBoundingClientRect());
          return;
        }
      }
    }
  }
  // No usable selection: fall back to the focused block/prompt/option, the
  // whole-block keyboard path from the first version, now reached the same
  // way as a selection instead of a separate Enter binding.
  const el = document.activeElement;
  if (el instanceof Element && el.classList.contains('annotatable')) {
    const target = resolveTarget(el);
    if (target) {
      const text = targets.get(keyString(target.key)).text;
      openCreatePopup(target.key, 0, text.length, el.getBoundingClientRect());
    }
  }
}

if (typeof document !== 'undefined') {
  commentInput.addEventListener('keydown', (event) => {
    // stopPropagation, not just preventDefault: app.js has its own
    // document-level Cmd/Ctrl+Enter listener for advancing/submitting the
    // question flow, and it must never see this keystroke while the
    // comment field has focus. Attaching directly to the field (rather
    // than relying on listener registration order at the document level)
    // is what guarantees that regardless of which module's listener was
    // registered first.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      save();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hidePopup();
    }
  });
  document.addEventListener('mousedown', (event) => {
    if (!popup.hidden && !popup.contains(event.target)) hidePopup();
  });

  // Clicking an existing mark opens the same edit popup the side panel
  // uses, pre-filled — a person reading back over marked-up text expects
  // clicking the highlight to show them what they wrote, the same way a
  // native comment/annotation UI would.
  document.addEventListener('click', (event) => {
    const mark = event.target instanceof Element ? event.target.closest('mark.annotation-mark') : null;
    if (!mark) return;
    const target = resolveTarget(mark);
    if (!target) return;
    openEditPopup(target.key, Number(mark.dataset.annotationIndex));
  });

  document.addEventListener('keydown', (event) => {
    const el = document.activeElement;

    // Acting on an existing mark via the keyboard: Delete/Backspace
    // removes it (Enter/click opening it is handled above and by the
    // panel; both removal paths — this one and the panel's Remove button —
    // are kept on purpose).
    if (el instanceof Element && el.classList.contains('annotation-mark')) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const target = resolveTarget(el);
        if (!target) return;
        removeRange(target.key, Number(el.dataset.annotationIndex));
        targets.get(keyString(target.key)).reset();
        notifyChanged();
      }
      return;
    }

    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'e') return;
    // Chrome and Safari bind Cmd/Ctrl+E to "use selection for find" —
    // without this, the browser's own default fires alongside (or instead
    // of) this handler's. Always prevented, even when nothing below ends
    // up opening a popup, so the browser default never sneaks through.
    event.preventDefault();
    if (isEditableTarget(event.target)) return; // already in the comment field, or an ordinary answer field — see the module comment above.
    annotateFromShortcut();
  });
}

// --- The side panel's view of existing annotations -----------------------------

/**
 * Every stored comment, in an app.js-friendly shape: the structured key
 * (so app.js can label it and switch to the right document/question view),
 * its index within that key (needed for edit/remove/jump), the comment
 * text, and the highlighted text it applies to.
 *
 * @returns {{key: string[], index: number, comment: string, highlight: string}[]}
 */
export function listAnnotations() {
  const entries = [];
  for (const [keyStr, ranges] of store) {
    const target = targets.get(keyStr);
    if (!target) continue;
    ranges.forEach((range, index) => {
      entries.push({ key: target.key, index, comment: range.comment, highlight: target.text.slice(range.start, range.end) });
    });
  }
  return entries;
}

export function removeAnnotation(key, index) {
  removeRange(key, index);
  targets.get(keyString(key))?.reset();
  notifyChanged();
}

/**
 * Scrolls a comment's mark into view and focuses it, if it is currently
 * rendered (the caller — app.js — is responsible for first switching to
 * the right document tab or question view, since this module does not
 * know about either).
 *
 * @param {string[]} key
 * @param {number} index
 * @returns {boolean} Whether a mark was found and focused.
 */
export function scrollToAnnotation(key, index) {
  const el = blockElements.get(keyString(key));
  const mark = el?.querySelector(`mark.annotation-mark[data-annotation-index="${index}"]`);
  if (!mark) return false;
  mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  mark.focus();
  return true;
}

// --- Assembling the result -----------------------------

/**
 * Build the `annotations` object matching the result contract in
 * README.md, from `store`/`targets` data — see {@link assembleAnnotations},
 * which does the actual work and is kept DOM-free and separately
 * exported/testable on purpose.
 */
export function buildAnnotationsPayload() {
  return assembleAnnotations(store, targets);
}

/**
 * Pure, DOM-free assembly of the `annotations` result: every leaf is the
 * block's/prompt's/option's own text with a CriticMarkup highlight and
 * comment spliced in around each annotated range, so a comment always
 * arrives together with the text it applies to. Ranges are applied right
 * to left (descending `start`) because, unlike the DOM wrapping above,
 * each `insertAnnotation` call lengthens the string — inserting the
 * rightmost range first keeps every earlier offset valid for the next
 * call.
 *
 * Accumulates through Maps and converts with `Object.fromEntries` at the
 * end, the same pattern lib/contract.js uses for the same reason: a
 * document id, question id, or option value here comes straight from the
 * calling agent's payload, and this project deliberately keeps
 * "__proto__" usable as an ordinary id (see the __proto__ tests in
 * test/contract.test.js). Plain-object bracket assignment on such a key —
 * `documents[documentId] ??= {}` — does not create an own property; it
 * reads and writes through Object.prototype's own "__proto__" accessor
 * instead, polluting every plain object on the page. Object.fromEntries
 * defines own properties directly and is immune to that.
 *
 * @param {Map<string, {start:number,end:number,comment:string|null}[]>} storeMap
 * @param {Map<string, {key: string[], text: string}>} targetsMap
 */
export function assembleAnnotations(storeMap, targetsMap) {
  const message = new Map();
  const documents = new Map(); // documentId -> Map(blockId -> text)
  const questions = new Map(); // questionId -> { prompt?, options?: Map(optionValue -> text) }

  for (const [key, ranges] of storeMap) {
    if (ranges.length === 0) continue;
    const target = targetsMap.get(key);
    let text = target.text;
    for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
      ({ text } = insertAnnotation(text, range.start, range.end, range.comment));
    }
    const [scope, ...rest] = target.key;
    if (scope === 'message') {
      message.set(rest[0], text);
    } else if (scope === 'document') {
      const [documentId, blockId] = rest;
      if (!documents.has(documentId)) documents.set(documentId, new Map());
      documents.get(documentId).set(blockId, text);
    } else if (scope === 'prompt') {
      const entry = questions.get(rest[0]) ?? {};
      entry.prompt = text;
      questions.set(rest[0], entry);
    } else if (scope === 'option') {
      const [questionId, optionValue] = rest;
      const entry = questions.get(questionId) ?? {};
      entry.options ??= new Map();
      entry.options.set(optionValue, text);
      questions.set(questionId, entry);
    }
  }

  const result = {};
  if (message.size) result.message = Object.fromEntries(message);
  if (documents.size) {
    result.documents = Object.fromEntries([...documents].map(([documentId, blocks]) => [documentId, Object.fromEntries(blocks)]));
  }
  if (questions.size) {
    result.questions = Object.fromEntries([...questions].map(([questionId, entry]) => {
      const value = {};
      if (entry.prompt !== undefined) value.prompt = entry.prompt;
      if (entry.options) value.options = Object.fromEntries(entry.options);
      return [questionId, value];
    }));
  }
  return result;
}
