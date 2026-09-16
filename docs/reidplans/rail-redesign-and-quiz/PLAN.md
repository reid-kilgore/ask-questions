# PLAN: rail redesign + quiz mode

Discovery/architecture done by dispatching session. Full brief lives in the dispatch
prompt (not reproduced here in full — see git history / dispatcher transcript for the
verbatim spec). This file is a handoff summary only.

## Scope
1. Rail redesign (front end only, no wire format change): question-0 context screen,
   left rail nav replacing Focus/All toolbar, draggable documents pane, new keyboard map,
   header without Submit button.
2. Quiz mode: new `quiz` question type in `lib/contract.js` + `web/app.js` +
   `bin/ask-questions.js`. Locks on pick, reveals why/cite, disagree toggle, rail
   amber-wins scoring, review score summary block.
3. Playwright proof: `examples/quiz.json`, `scripts/quiz-proof.mjs`, screenshots under
   `docs/screenshots/quiz/`.

## Explicitly out of scope
Contract v2 / attachments (file upload). `version` stays 1.

## Working notes / deviations
- No `bd` on this machine; plain git only.
- No Task/dispatch tool available in this session — implemented directly rather than via
  code-architect/test-runner/etc subagents. Ran `npm test` / `npm run check` myself as gates.
- Deviations from the brief, if any, recorded in the final report sent to the dispatcher.

## Status
See final report to dispatcher for completion state, PR URL, and test output.
