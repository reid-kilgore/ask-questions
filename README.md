# ask-questions

`ask-questions` is a local blocking question form for agent workflows. A coding agent sends it a JSON request describing one or more questions; it opens a private page in your browser; you answer (and optionally annotate); it prints one JSON result to standard output when you submit or cancel.

## Install

This is a laptop-local tool, not a published package. It needs two sibling checkouts side by side:

```sh
git clone git@github.com:reid-kilgore/ask-questions.git
git clone git@github.com:reid-kilgore/criticmarkup.git
cd ask-questions
npm install
npm link
```

`criticmarkup` must sit next to `ask-questions` (i.e. `../criticmarkup` relative to this repository) before `npm install` — it is referenced from `package.json` as a local `file:` dependency, not a published one, because it is a small zero-dependency library this project's author also maintains. `npm install` fails without it present at that path. The server imports it directly, and also serves its single source file to the browser verbatim, since the browser has no bundler and no other client-side dependencies of its own.

`npm link` puts the `ask-questions` command on your `PATH`, pointing at this checkout. Confirm it worked:

```sh
ask-questions --help
```

`--help` is the complete contract a calling agent needs — payload schema, result shape, and behavior, all in one place. Read it before wiring this into an agent.

## Try it

```sh
ask-questions --file examples/request.json
```

This opens a browser page with a small multi-question batch. Answer the questions (or press Cancel) and the command prints the result JSON and exits.

A payload looks like this:

```json
{
  "version": 1,
  "message": "## Context\n\nInclude **relevant details** here.",
  "questions": [
    { "id": "summary", "prompt": "What is the main concern?", "type": "text" },
    { "id": "priority", "prompt": "What priority should this have?", "type": "single",
      "options": [{ "value": "high", "label": "High" }, { "value": "normal", "label": "Normal" }] }
  ]
}
```

Send it with `--json '...'`, `--file path.json`, or piped over stdin. `--help` has the full schema and several more worked examples, including supporting documents.

## Annotating, not just answering

The person answering isn't limited to filling in answers — they can comment directly on the text they're reading: a supporting document, the introductory message, or a question's prompt and option descriptions. This is aimed at review-style questions, where the useful response is "here's specifically what's unclear," not just a form field.

**To comment on something:** select the text (or, with no selection, just click into a paragraph, list item, or other block to focus it) and press **Cmd+E** (Ctrl+E off macOS). A small popup opens; type the comment and press Cmd/Ctrl+Enter to save, or Escape to cancel. There's a quiet on-screen reminder of this the first time the page loads.

A comment always has both a highlight and text explaining it — there's no separate "just highlight, no comment" action. **Clicking an existing highlighted mark reopens the same popup**, pre-filled, to edit it. **Delete or Backspace removes it** while the mark has keyboard focus. A **Comments** button, top right of the main pane, opens a panel listing every comment made so far, with its own count; from there a comment can be jumped to, edited, or removed, wherever in the form it lives.

Annotating is entirely optional. It's never required to submit, and it never changes the shape of the `answers` result — see below.

### What the calling agent gets back

Alongside `answers`, the result carries a top-level `annotations` object — always present, defaulting to `{}` when nothing was annotated or the request was cancelled. Every leaf is the original text with the highlighted part wrapped in [CriticMarkup](http://criticmarkup.com/) and the comment attached right there, so the calling agent always sees the comment together with exactly what it's about:

```json
{
  "annotations": {
    "message": {
      "2-3": "a rewritten sentence would be {==clearer==}{>>say why<<}"
    },
    "documents": {
      "release-notes": {
        "4-5": "the {==rollback plan==}{>>this needs a specific runbook link<<} needs detail"
      }
    },
    "questions": {
      "decision": {
        "prompt": "Should we {==ship this release==}{>>waiting on the perf numbers<<}?"
      }
    }
  }
}
```

`message` and `documents` are keyed by the source Markdown line range the comment's block came from (e.g. `"2-3"`) — directly usable against the document the calling agent already holds. `questions` entries are keyed by question id, with `prompt` and/or `options.<value>` holding the annotated prompt or option description text.

## Documents, options, and other detail

Supporting documents use unique `id` and `title` values, and each has exactly one of inline `markdown` or a relative `path` (resolved against the payload file's directory for `--file`, or the current directory for `--json`/stdin — a document path can't escape that directory). The introductory `message`, documents, and option descriptions all accept Markdown; raw HTML is disabled and unsafe link schemes are neutralized. `--help` covers the full payload schema, including choice questions, the built-in `Other` free-text option, and required questions.

Every result also contains `askerPath`, the absolute directory the command was run from (a payload can't set or override it), shown in the browser as **Asked from**. Inside tmux, `askerTmuxWindow` is included too when the current window's name can be looked up.

There is no built-in answer timeout — a human can take hours. The command just blocks until Submit, Cancel, or Ctrl-C; calling agents need to disable their own execution timeout (or set it to several hours) rather than treat normal waiting as a failure.

The ready sound plays once the page is ready and is on by default; use `--no-ding` to turn it off. `--no-open` skips launching a browser automatically — useful for automation — the session URL is always printed to standard error regardless, as a plain line or (when standard error is a terminal) also as a clickable OSC 8 hyperlink.

## What this is, and isn't

The browser interface is a proof of concept: it starts in Focus mode with an All-questions view alongside it, has no authentication beyond binding to `127.0.0.1` and using a random per-session URL token, and has no persistence or session recovery. On the final review screen, **Copy as JSON** copies the exact result JSON (including any annotations) to the clipboard without submitting, which is the one recovery option if a calling agent has already timed out while the page is still open — it can't restart a stopped command or restore a closed tab.
