# Plan

Build a small local Node.js command line tool. It reads one payload with one or more questions, validates it, starts a token-protected localhost page, waits for a person to submit or cancel, and writes one JSON result.

The command line help is the primary agent contract. An agent must be able to use `ask-questions --help` without reading a separate document. It includes input modes, schema, lifecycle, output, exit codes, and copy-paste examples.

The proof of concept uses no application framework or build step. It loads optional Markdown files before it starts the web server and sends rendered content to the page. The server does not expose a general file route.

Payload values are added to the browser page with DOM text and property APIs. Markdown is the only HTML source. It has raw HTML disabled, rejects unsafe link schemes, and adds safe new-tab settings to external web links. Document files use lexical and canonical-path containment checks. This blocks `..` traversal and symbolic links to files outside the input directory.

Out of scope: authentication, session recovery, concurrent users, persistent records, file upload, and a large test suite.

## Scope addendum: live design review

Focus mode is the default view for new sessions. All question cards remain available through the existing view toggle. Focus mode shows one card at a time with previous, next, and progress controls. It only hides cards, so entered values and always-visible notes fields remain unchanged when the view changes.

On wide screens, the question column and the supporting-document column scroll independently. The document pane stays at the top. All document tabs stay visible without an internal tab scrollbar; only the document content has an internal vertical scrollbar. On narrow screens, the layout returns to one vertical page.

Submitted output uses an answers object keyed by question id. Each keyed value contains `value` and `notes`; it does not repeat the question id. Cancellation uses an empty answers object. The page shows a submitted or cancelled completion state only after HTTP 200, then tries to close its tab and retains a close-tab fallback.

The final review screen also provides **Copy as JSON**. It builds and copies the submitted-result JSON only in the browser. It does not submit or contact the server, so it can recover the visible answers if a calling agent times out and the loaded page remains open after the server stops. It is not persistence or session recovery.

## Scope addendum: second interface review

Focus mode is the default and opens with the first question. All-question mode remains available through the existing view toggle and shows only Cancel and Submit actions. Focus mode places Previous and Next in the main action area. It validates a required question before it advances. The last question opens a separate review page that safely summarizes all answers and notes. The review page validates all required questions again before it submits.

The Other text input is visible only while Other is selected. Changing a radio answer or unchecking a multiple-choice Other answer clears and hides the text. Focus question and review stages use a stable minimum height to reduce movement. Supporting-document pane behavior remains unchanged.

The command help tells agents to write questions in simple technical English and to include needed context in prompts, option descriptions, or supporting Markdown documents.

## Scope addendum: final live review

Focus mode lets the user move freely with Next, even when a required answer is empty. Required validation happens only on Submit from the final review page. If validation finds missing answers, the page returns to the first missing focused question, preserves values, and shows a clear message.

Command or Control plus Enter moves to Next in focused question pages and submits from the review page. It does not run in all-question mode. Repeat key events do not create duplicate actions. A small visible hint describes the shortcut in focus mode.

## Bugfix addendum: linked command help

Report: `ask-questions --help` exited successfully after `npm link`, but did not write help text.

Root cause: the direct-entry check compared `process.argv[1]`, which is the symbolic-link path, with the canonical module path. The values differ when `npm link` starts the command, so `main()` did not run.

Scope: compare the canonical paths for the invoked command and this module. Add one regression test that starts the executable through a temporary symbolic link. Do not change command options or help content.

Verification: the new linked-command test passes. `npm test`, `npm run check`, `git diff --check`, the repository trailing-whitespace scan, and the installed `ask-questions --help` command pass.

## Decision addendum: long human response wait

The command help must tell calling agents that a human can take hours to answer. The command has no built-in answer timeout and remains blocked until Submit, Cancel, or an interruption. Calling agents must disable their execution timeout or set it to several hours. Normal waiting is not a failure. Keep this guidance near Lifecycle and output.

## Scope addendum: request origin and ready sound

Each invocation captures `process.cwd()` as the mandatory absolute `askerPath`. Payload input cannot define or replace this value. The local session and both final result types include it. The browser shows the full path under the title as **Asked from**. It uses text properties and a copy action. The path wraps on narrow layouts.

When `TMUX_PANE` is available, the command makes one bounded best-effort `tmux display-message` lookup for the current window name. Lookup errors, a missing tmux command, a stale pane, an empty result, and a timeout are ignored. A found name is shown with the path and included as optional `askerTmuxWindow` metadata.

The ready sound is enabled by default and plays one sound after the localhost listener and URL are ready. `--no-ding` disables it; `--ding` enables it again. When both options occur, the last option wins. It uses the macOS Glass sound where available and an error-safe terminal-bell fallback elsewhere. It never waits for playback or writes sound data to standard output.

## Scope addendum: Markdown message

The existing optional `message` string is the introductory content at the top of the question page. It now accepts Markdown. The command renders it on the server with the same Markdown renderer and safety configuration that it uses for supporting documents, then sends the resulting `messageHtml` to the local page. The page inserts only that server-rendered HTML.

This keeps headings, lists, emphasis, code, and safe links useful in the introductory message. Raw HTML stays disabled. Unsafe URL schemes stay neutralized. The change does not add payload fields, a browser Markdown library, or a new file route.

Implementation uses the existing `markdown.render()` instance in `bin/ask-questions.js`. `readPayload()` creates `messageHtml`, `/api/session` sends it, and `web/app.js` inserts it into a `div` message container. The browser never renders the raw `message` string as HTML.

## Scope addendum: question batches in help

The command help and README give light guidance that one payload can contain several related questions. One-question payloads remain valid. Each displayed inline JSON payload in the help Examples section contains at least two questions. The examples keep the inline-Markdown-document and relative-path-Markdown-document cases.

## Concepts to Trace

- `payload.message`: the existing optional string that agents use for introductory context.
- Server-side Markdown renderer: the sole renderer for documents and the new message output.
- Session API: the transfer boundary from validated payload data to the local browser.
- Browser message container: must receive only renderer output, never raw payload text as HTML.
