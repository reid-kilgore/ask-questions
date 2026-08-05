# Contracts

## Command contract

`ask-questions` accepts exactly one payload source: `--json`, `--file`, or standard input when neither option is given. `--json` and `--file` cannot be used together. `--no-open` prevents automatic browser launch but still writes the session URL to standard error.

`ask-questions --help` is self-sufficient. It includes local proof-of-concept installation with `npm install` and `npm link`. It defines every payload field, question type, document path rule, JSON result shape, standard output and standard error separation, blocking behavior, exit codes, browser behavior, and Ctrl-C behavior. It includes copy-paste examples for file input, inline JSON, standard input, result capture, and `--no-open` automation. The automated tests check key help sections.

The command can wait hours for a human answer. It has no built-in answer timeout and remains blocked until Submit, Cancel, or an interruption. Calling agents must disable their execution timeout or set it to several hours. Normal waiting is not a failure.

`npm link` is the primary installation method. It makes this checkout a laptop-local PATH utility. It does not publish a package. Agents must write questions in simple technical English and include all relevant context in the message, question, option descriptions, or a supporting Markdown document.

The ready sound is enabled by default. `--no-ding` disables it and `--ding` enables it. When both options occur, the last option wins. After the local page listener and session URL are ready, it starts one short ready sound without waiting for it. It works with every input mode and with `--no-open`. It writes neither sound data nor sound status to standard output. The command uses the macOS Glass sound when possible and an error-safe terminal bell fallback otherwise.

## Payload contract

The input is a JSON object with `version: 1` and a non-empty `questions` array. One payload can batch several related questions, but a payload with one question remains valid. Question ids and document ids are unique. Supported question types are `single`, `multiple`, and `text`. Choice questions require valid unique options. Each question provides a notes text area.

The optional non-empty `message` string accepts Markdown and provides introductory context above the questions. The server renders it with the same renderer used for supporting documents and returns `messageHtml` in session data. The browser inserts only `messageHtml` into the message `div`. Markdown supports normal headings, lists, emphasis, code, and safe links. Raw HTML remains disabled. Unsafe URL schemes remain neutralized. The payload format does not add a `messageHtml` input field.

Each document has a unique non-empty `id`, a non-empty `title`, and one `markdown` field or one relative `path` field, never both. Paths resolve from the JSON file directory for `--file`, otherwise the current directory. Lexical and real-path checks prevent paths and symbolic links from leaving that directory. Markdown raw HTML is disabled. Unsafe link schemes are rejected. External web links open with `noopener noreferrer`.

## Result contract

Submit writes `{version:1,status:'submitted',answers,submittedAt}` and exits 0. `answers` is an object keyed by question id. Each keyed answer contains `value` and `notes`; it does not contain a redundant `questionId`. `notes` is always a string and can be empty because the user interface field is optional. Cancel or Ctrl-C writes `{version:1,status:'cancelled',answers:{}}` and exits 2. Validation and server errors write diagnostics to standard error and exit 1. Standard output contains only the final JSON result on success or cancellation.

Every submitted and cancelled result includes top-level `askerPath`. It is the absolute command current working directory from `process.cwd()` at invocation. Payload JSON cannot provide or override it. Browser session data also includes `askerPath`, and the page shows it as **Asked from** with a copyable full-path display. If a bounded best-effort tmux lookup finds a current window name, session data and results also include top-level `askerTmuxWindow`. No tmux lookup error can fail the command.

The final review screen has a **Copy as JSON** button. It builds the submitted-result envelope from loaded session metadata and current browser answers, then copies it without a network request or submission. It first uses the same required-answer check as Submit. This is a manual clipboard recovery option when a calling agent timed out and the page remains open, even if the command server has stopped. It is not persistence or session recovery. It does not save answers, restart a stopped command, or restore a closed page.

## Scope addendum: interaction design

The default page opens in Focus mode on the first question. All questions remain available through the existing view toggle. Focus mode shows one question card at a time, with previous, next, and progress controls. It hides cards only, so answers remain present when the user changes the view.

The wide-screen supporting-document pane remains at the top while questions scroll. The document tab grid has no internal vertical scroll area, so all tab rows remain visible. Document content is the only internal vertical scroll area. After the page receives HTTP 200 for Submit or Cancel, it replaces the form with an accessible completion state, attempts to close the tab, and keeps a visible close-tab instruction if the browser does not close it.

## Scope addendum: second interface review

Focus mode is the default. All-question mode shows Cancel and Submit only and remains available through the existing view toggle. Focus mode moves Previous and Next into the main action area and hides Cancel and Submit until review. The last Next opens a review page. It safely renders all questions, answers, and notes with DOM text APIs. The review page shows Previous, Submit, and a secondary Cancel action.

Focus mode does not validate a required question before it advances. Submit on the final review page validates all required questions. If answers are missing, the page returns to the first missing focused question, keeps entered values, and shows a clear error. Other inputs are visible only while selected and are cleared when their selection is removed. A stable focus-stage size reduces page movement. The supporting-document pane remains unchanged.

## Scope addendum: final live review

In focus mode, Command or Control plus Enter performs Next on a question page and Submit on the review page. It does not run in all-question mode. Repeated key events and disabled actions do not create duplicate requests. A compact hint is visible in focus mode.
