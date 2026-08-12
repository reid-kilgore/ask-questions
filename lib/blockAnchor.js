// Stamps a source-line-range id onto every renderable block-level element a
// markdown-it token stream produces, and extracts each block's own plain
// text (what a browser's `element.textContent` would read for that element)
// into `env.blockText`. The browser never sees Markdown source — only
// rendered HTML — so `env.blockText` is what lets it anchor an annotation
// to a source range without searching rendered text back against source.
//
// `env.blockText` is the single authority for annotation offsets: the
// server computes it once here, sends it to the page next to the rendered
// HTML, and the browser confirms its own DOM text agrees before allowing an
// annotation on that block (see web/annotate.js). Nothing here re-derives
// or double-checks against the browser's view — that direction of proof is
// the browser's job, not this module's.

/**
 * The id used for both the `data-block` DOM attribute and the corresponding
 * key in `env.blockText`. It is the exact `[startLine, endLine)` markdown-it
 * assigns the token, formatted as `"start-end"` — an implementation detail
 * derived from `token.map`, not a stable public identifier.
 *
 * @param {[number, number]} map
 * @returns {string}
 */
function blockId(map) {
  return `${map[0]}-${map[1]}`;
}

/**
 * Plain text of one `inline` token's children, matching how a browser
 * reads `textContent` from the HTML markdown-it renders for the same
 * token: `text` and `code_inline` content is included verbatim, a
 * `softbreak`/`hardbreak` contributes exactly one `\n` (markdown-it's
 * default renderer rules emit a literal `\n` text node for both, see
 * node_modules/markdown-it/lib/renderer.mjs), and every other inline token
 * (emphasis markers, link markers, images) contributes nothing of its own —
 * markers render as attributes or surrounding tags, not text nodes, and an
 * `<img>` has no text content either. Nested text between open/close
 * markers already appears as sibling children in `token.children`, so this
 * needs no recursion.
 *
 * @param {object[]} [children]
 * @returns {string}
 */
function inlinePlainText(children) {
  let text = '';
  for (const child of children ?? []) {
    if (child.type === 'text' || child.type === 'code_inline') text += child.content;
    else if (child.type === 'softbreak' || child.type === 'hardbreak') text += '\n';
  }
  return text;
}

/**
 * Walk a markdown-it token stream and return a Map from block id to that
 * block's plain text, matching `element.textContent` for the element
 * markdown-it's renderer produces for the same token.
 *
 * This is a depth-first, stack-based walk rather than special-casing each
 * container type (blockquote, list, table): every open/close token pair
 * with a `map` pushes/pops an id onto a stack, and every `inline` token's
 * text is appended to every currently-open id — which is exactly how
 * `textContent` itself accumulates, depth first, with no separators between
 * descendants. `fence` and `code_block` are leaf tokens (not an open/close
 * pair) with their own `map` and raw `content`; that content is used
 * directly, since a fenced block's `<code>` has no nested markup for its
 * text to diverge from `token.content` — only HTML-escaping, which round
 * -trips losslessly through `textContent`'s decoding.
 *
 * @param {object[]} tokens
 * @returns {Map<string, string>}
 */
function extractBlockText(tokens) {
  const blockText = new Map();
  const stack = [];
  const write = (openIds, chunk) => {
    if (chunk === '') return;
    // Some block tokens have no map at all (table cells: th_open/td_open),
    // and are still pushed onto the stack to keep push/pop balanced with
    // their close token. They get no data-block attribute either, so they
    // must not gain a blockText entry keyed by `null`.
    for (const id of new Set(openIds)) { if (id !== null) blockText.set(id, (blockText.get(id) ?? '') + chunk); }
  };

  for (const token of tokens) {
    if (token.type === 'inline') {
      write(stack, inlinePlainText(token.children));
    } else if (token.type === 'fence' || token.type === 'code_block') {
      if (token.map) write([blockId(token.map)], token.content);
      write(stack, token.content);
    } else if (token.nesting === 1) {
      stack.push(token.map ? blockId(token.map) : null);
    } else if (token.nesting === -1) {
      stack.pop();
    }
    // nesting === 0 tokens other than fence/code_block (hr, disabled
    // html_block) render no text content of their own.
  }

  return blockText;
}

/**
 * Register the block-anchor core rule on a markdown-it instance. Every
 * `md.render(source, env)` call afterwards stamps a `data-block="start-end"`
 * attribute onto each renderable block element and populates
 * `env.blockText` with that same id mapped to the block's plain text.
 *
 * Verified first-hand against markdown-it 14.3.0 (the version installed
 * here): block-opening tokens (`paragraph_open`, `heading_open`,
 * `list_item_open`, `blockquote_open`, `table_open`, `tr_open`, ...) carry
 * `.map` and are `nesting === 1`; `fence` and `code_block` also carry `.map`
 * but are self-closing (`nesting === 0`), which a naive `nesting === 1`
 * filter misses. `inline` tokens carry the same `.map` as their parent
 * block but are not separately rendered elements, so they are excluded by
 * `type !== 'inline'`. Note fence's attrs land on its `<code>` tag, not
 * `<pre>` — that is where markdown-it's own fence rule calls
 * `renderAttrs`, not a bug in this rule.
 *
 * @param {import('markdown-it')} md
 */
export function installBlockAnchors(md) {
  md.core.ruler.push('block-anchor', (state) => {
    for (const token of state.tokens) {
      if (token.map && token.nesting !== -1 && token.type !== 'inline') {
        token.attrSet('data-block', blockId(token.map));
      }
    }
    state.env.blockText = Object.fromEntries(extractBlockText(state.tokens));
  });
}
