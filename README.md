# ask-questions

`ask-questions` is a local blocking question form for agent workflows. It accepts a JSON request, opens a private localhost page, then prints one JSON result when the person submits or cancels.

Use `npm link` as the primary installation method. It makes this checkout a laptop-local PATH utility and does not publish a package. Then use the command help as the complete integration contract:

```sh
npm install
npm link
ask-questions --help
```

For a local example:

```sh
ask-questions --file examples/request.json
```

The submitted result has an `answers` object keyed by question id. Each value contains `value` and `notes`. Cancellation returns an empty answers object.

Every result also contains `askerPath`. The command derives this absolute path from its current working directory. A payload cannot set or change it. The browser page shows the path as **Asked from** and lets the person copy it. When the command starts in tmux, it makes a short best-effort lookup of the current window name. If available, it shows and returns `askerTmuxWindow`.

The ready sound is enabled by default. Use `--no-ding` when it is not useful:

```sh
ask-questions --file examples/request.json --no-ding
```

The sound starts only after the local page is ready, also works with `--no-open`, and does not write sound data or status to standard output. If both `--ding` and `--no-ding` occur, the last option wins.

The command opens the session URL with the platform browser opener. When that opener cannot start, or exits with a non-zero code or a signal, the command writes one warning to standard error and keeps waiting. The URL is already on standard error, so you can open it by hand. Inside tmux the warning adds a hint. A tmux server that has run for a long time can stay attached to a graphical session that no longer exists. Every browser launch from such a server fails, on macOS with error `-600`. Restarting the tmux server from a terminal window repairs it.

When standard error is a terminal, the command also writes the session URL as an OSC 8 hyperlink. A terminal that supports hyperlinks can then open the page directly. The terminal does this, not the command, so it still works when the browser opener fails. When standard error is redirected or piped, the plain URL is written with no escape sequences, which keeps captured agent logs clean.

A human can take hours to answer. There is no built-in answer timeout. The command remains blocked until Submit, Cancel, or an interruption. Calling agents must disable their execution timeout or set it to several hours. Normal waiting is not a failure.

Write questions in simple technical English. Include all relevant context in the Markdown `message`, question, option descriptions, or a supporting Markdown document. The introductory `message` supports headings, lists, emphasis, code, and safe links. Raw HTML is disabled and unsafe link schemes are neutralized.

You can batch several related questions in one payload. A payload with one question is also valid. The included `examples/request.json` shows a multi-question batch.

Supporting documents use unique non-empty `id` and `title` values. Each document has exactly one of `markdown` or relative `path`. For `--file`, paths are relative to the payload file directory. For `--json` and standard input, paths are relative to the current directory. Lexical and symbolic-link checks keep paths inside that directory. The command help includes complete examples for inline Markdown and relative-path Markdown documents.

The browser interface is a proof of concept. It starts in Focus mode and also provides an All questions view. It has no authentication, persistence, or session recovery. It only binds to `127.0.0.1`, uses a random URL token, and does not serve document files directly.

On the final review screen, **Copy as JSON** copies the submitted-result JSON without submitting or making a network request. This is useful if the calling agent times out while the page is still open. It is a manual clipboard recovery option, not persistence or session recovery. It cannot restart a stopped command or restore a closed page.
