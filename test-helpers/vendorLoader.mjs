// Test-only ESM resolve hook (node:module's `register`, a Node built-in —
// no new dependency). web/annotate.js imports criticmarkup as a relative
// './vendor/criticmarkup.js', a path that only exists as a route the
// running server synthesizes from node_modules/criticmarkup at request
// time (see bin/ask-questions.js) — there is deliberately no such file on
// disk, so the browser's copy of criticmarkup never drifts from the
// installed one. That means Node's own module resolution can't import
// web/annotate.js directly; this hook redirects that one specifier to the
// real installed package, for tests only. It changes nothing about what
// ships to the browser.
//
// Lives outside test/ on purpose: Node's default test-file discovery
// treats every file under any directory literally named "test" as a test
// file to run, which would otherwise pick this up and report it as an
// (empty, meaningless) passing test.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/vendor/criticmarkup.js')) {
    return nextResolve(new URL('../node_modules/criticmarkup/src/index.js', import.meta.url).href, context);
  }
  return nextResolve(specifier, context);
}
