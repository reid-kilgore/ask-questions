// Lets a person mark up the text they are reading — documents, the message,
// question prompts, and option descriptions — with CriticMarkup highlights
// and optional comments, block level. See README.md for the shape this
// produces; this module only builds that shape and drives the DOM, it does
// not know about submit/cancel/review at all — app.js owns that.
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

// store: keyString -> [{ start, end, comment }], offsets against `text`.
const store = new Map();

function addRange(key, start, end, comment) {
  if (start >= end) return { ok: false, reason: 'Select some text first.' };
  const ranges = store.get(keyString(key)) ?? [];
  if (ranges.some((range) => start < range.end && range.start < end)) {
    return { ok: false, reason: 'That text already has an annotation.' };
  }
  store.set(keyString(key), [...ranges, { start, end, comment }]);
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
 * highlight body ends at the first literal `==}` that follows it, and a
 * comment body ends at the first literal `<<}`. Text or a comment
 * containing that exact sequence would produce markup that looks valid but
 * does not round-trip — the server's own `clearAnnotations` check (which is
 * correct, and stays exactly as it is) would then reject the whole submit
 * request, with no indication of which mark caused it. Refusing at
 * creation time, with a reason the person can act on, is the fix: don't
 * produce markup that cannot round-trip in the first place.
 *
 * Pure and DOM-free on purpose, so it is directly testable without a
 * browser.
 *
 * @param {string} highlightText
 * @param {string|null} comment
 * @returns {string|null} A reason the annotation cannot be created, or null if it is safe.
 */
export function unsafeDelimiterReason(highlightText, comment) {
  if (highlightText.includes('==}')) {
    return 'That text contains "==}", which CriticMarkup cannot highlight — it has no way to escape it. Select a shorter or different range.';
  }
  if (comment !== null && comment.includes('<<}')) {
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
// unlike the string-splicing in buildPayload() below.
function wrapRange(root, start, end, comment, index) {
  if (start === end) return;
  const startPosition = domPositionAt(root, start);
  const endPosition = domPositionAt(root, end);
  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  const mark = document.createElement('mark');
  mark.className = comment ? 'annotation-mark has-comment' : 'annotation-mark';
  mark.tabIndex = 0;
  mark.dataset.annotationIndex = String(index);
  if (comment) mark.title = comment;
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

// --- Toolbar and popover UI -----------------------------
//
// Declared with `let` and built only when `document` exists, so that this
// module — and the pure, DOM-free functions above (unsafeDelimiterReason,
// firstOccurrenceOnly, assembleAnnotations) — stay importable and testable
// under plain Node, with no browser and no new dependency. Nothing here
// changes what runs in an actual browser: `document` always exists there,
// so this block always runs, exactly as before.
let toolbar, highlightButton, commentButton, commentInput, addCommentButton, status;

if (typeof document !== 'undefined') {
  toolbar = document.createElement('div');
  toolbar.className = 'annotation-toolbar';
  toolbar.hidden = true;
  highlightButton = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Highlight' });
  commentButton = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Comment' });
  commentInput = Object.assign(document.createElement('textarea'), { rows: 2, placeholder: 'Add a comment' });
  commentInput.hidden = true;
  addCommentButton = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Add' });
  addCommentButton.hidden = true;
  status = document.createElement('span');
  status.className = 'annotation-status';
  status.setAttribute('role', 'status');
  toolbar.append(highlightButton, commentButton, commentInput, addCommentButton, status);
  document.body.append(toolbar);
}

let pending = null; // { key, root, start, end }

function place(rect) {
  toolbar.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  toolbar.style.top = `${Math.max(8, rect.top + window.scrollY - toolbar.offsetHeight - 8)}px`;
}

function hideToolbar() {
  pending = null;
  toolbar.hidden = true;
  commentInput.hidden = true;
  commentInput.value = '';
  addCommentButton.hidden = true;
  status.textContent = '';
}

function openCreate(key, root, start, end, rect) {
  pending = { key, root, start, end };
  status.textContent = '';
  commentInput.hidden = true;
  addCommentButton.hidden = true;
  toolbar.hidden = false;
  place(rect);
  highlightButton.focus();
}

function commit(comment) {
  if (!pending) return;
  const { key, start, end } = pending;
  const highlightText = targets.get(keyString(key)).text.slice(start, end);
  const unsafeReason = unsafeDelimiterReason(highlightText, comment);
  if (unsafeReason) {
    status.textContent = unsafeReason;
    return;
  }
  const outcome = addRange(key, start, end, comment);
  if (!outcome.ok) {
    status.textContent = outcome.reason;
    return;
  }
  targets.get(keyString(key)).reset();
  window.getSelection()?.removeAllRanges();
  hideToolbar();
}

// --- Mouse selection, and keyboard: block-level annotate and acting on an
// existing mark -----------------------------
//
// Selection-driven annotation is mouse/pointer-only — the blocks, prompts,
// and option descriptions here are plain elements, not text inputs, and a
// keyboard user has no way to start a Shift+Arrow selection inside one
// without a prior click. What keyboard users get instead, since anchoring
// is block level anyway: Tab to any annotatable block/prompt/option and
// press Enter to comment on the whole thing, no selection required. An
// existing mark is itself a Tab stop; Enter opens it, Delete removes it.

if (typeof document !== 'undefined') {
  highlightButton.addEventListener('click', () => commit(null));
  commentButton.addEventListener('click', () => {
    commentInput.hidden = false;
    addCommentButton.hidden = false;
    commentInput.focus();
  });
  addCommentButton.addEventListener('click', () => {
    const comment = commentInput.value.trim();
    commit(comment === '' ? null : comment);
  });
  commentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideToolbar();
  });
  document.addEventListener('mousedown', (event) => {
    if (!toolbar.hidden && !toolbar.contains(event.target)) hideToolbar();
  });

  document.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const startTarget = resolveTarget(range.startContainer);
    const endTarget = resolveTarget(range.endContainer);
    if (!startTarget || !endTarget || keyString(startTarget.key) !== keyString(endTarget.key)) return;
    const start = offsetInRoot(startTarget.root, range.startContainer, range.startOffset);
    const end = offsetInRoot(startTarget.root, range.endContainer, range.endOffset);
    if (start === null || end === null) return;
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    if (lo === hi) return;
    openCreate(startTarget.key, startTarget.root, lo, hi, range.getBoundingClientRect());
  });

  document.addEventListener('keydown', (event) => {
    const el = document.activeElement;
    if (!(el instanceof Element)) return;
    if (el.classList.contains('annotation-mark')) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const target = resolveTarget(el);
        if (!target) return;
        removeRange(target.key, Number(el.dataset.annotationIndex));
        targets.get(keyString(target.key)).reset();
      }
      return;
    }
    if (el.classList.contains('annotatable') && event.key === 'Enter' && !event.repeat) {
      event.preventDefault();
      const target = resolveTarget(el);
      if (!target) return;
      const text = targets.get(keyString(target.key)).text;
      openCreate(target.key, target.root, 0, text.length, el.getBoundingClientRect());
    }
  });
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
 * block's/prompt's/option's own text with CriticMarkup markers spliced in
 * around each highlighted range, so a comment always arrives together with
 * the text it applies to. Ranges are applied right to left (descending
 * `start`) because, unlike the DOM wrapping above, each `insertAnnotation`
 * call lengthens the string — inserting the rightmost range first keeps
 * every earlier offset valid for the next call.
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
