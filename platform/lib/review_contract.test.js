"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyEdit,
  assertSafeEdit,
  commentBody,
  parseReview,
} = require("./review_contract");

const original = [
  "def health_body():",
  '    return {"status": "broken"}',
  "",
].join("\n");

const edit = {
  file: "app/server.py",
  old: '    return {"status": "broken"}',
  new: '    return {"status": "ok"}',
};

test("parseReview accepts fenced JSON", () => {
  const review = parseReview(
    '```json\n{"summary":"fix it","verdict":"request_changes","edit":{"file":"app/server.py","old":"a","new":"b"}}\n```',
  );
  assert.equal(review.verdict, "request_changes");
  assert.deepEqual(review.edit, { file: "app/server.py", old: "a", new: "b" });
});

test("parseReview accepts a null, missing or empty edit", () => {
  for (const tail of ['"edit":null', '"edit":""', ""]) {
    const body = '{"summary":"fine","verdict":"approve"' + (tail ? "," + tail : "") + "}";
    assert.equal(parseReview(body).edit, null);
  }
});

test("parseReview reads a reply that stopped before the closing quote", () => {
  const reply =
    '{"summary":"health_body returns the wrong status string.","verdict":"request_changes","edit":{"file":"app/server.py","old":"    return {\\"status\\": \\"ok\\"}","new":"    return {\\"status\\": \\"broken\\"}}}'
  const review = parseReview(reply);
  assert.equal(review.verdict, "request_changes");
  assert.equal(review.edit.file, "app/server.py");
  assert.equal(review.edit.old, '    return {"status": "ok"}');
  assert.equal(review.edit.new, '    return {"status": "broken"}');
});

test("parseReview escapes quotes the model left raw", () => {
  const reply =
    '{"summary":"fix it","verdict":"request_changes","edit":{"file":"app/server.py","old":"    return {"status": "broken"}","new":"    return {"status": "ok"}"}}';
  const review = parseReview(reply);
  assert.equal(review.edit.old, '    return {"status": "broken"}');
  assert.equal(review.edit.new, '    return {"status": "ok"}');
});

test("parseReview rejects a bad verdict", () => {
  assert.throws(() =>
    parseReview('{"summary":"x","verdict":"shipit","edit":null}'),
  );
});

test("parseReview rejects a malformed edit", () => {
  assert.throws(() =>
    parseReview('{"summary":"x","verdict":"request_changes","edit":{"file":"app/a.py"}}'),
  );
  assert.throws(() =>
    parseReview('{"summary":"x","verdict":"request_changes","edit":"change it"}'),
  );
});

test("assertSafeEdit allows app only", () => {
  assert.equal(assertSafeEdit(edit), "app/server.py");
  assert.equal(assertSafeEdit({ ...edit, file: "./app/server.py" }), "app/server.py");
  assert.equal(assertSafeEdit(null), "");
});

test("assertSafeEdit refuses tests, workflows, Dockerfile and traversal", () => {
  for (const file of [
    "tests/test_health.py",
    ".github/workflows/ci.yml",
    "Dockerfile",
    "platform/docker-compose.yml",
    "app/../../.ssh/id_rsa",
    "/etc/passwd",
    "app\\server.py",
    "",
  ]) {
    assert.throws(() => assertSafeEdit({ ...edit, file }), undefined, file);
  }
});

test("assertSafeEdit refuses empty and no-op edits", () => {
  assert.throws(() => assertSafeEdit({ ...edit, old: "  " }));
  assert.throws(() => assertSafeEdit({ ...edit, new: edit.old }));
});

test("applyEdit replaces the broken status", () => {
  const next = applyEdit(original, edit);
  assert.match(next, /"status": "ok"/);
  assert.doesNotMatch(next, /broken/);
  assert.ok(next.endsWith("\n"));
});

test("applyEdit does not treat the replacement as a pattern", () => {
  const next = applyEdit("price = 1\n", { file: "app/a.py", old: "price = 1", new: "price = '$&$1'" });
  assert.equal(next, "price = '$&$1'\n");
});

test("applyEdit fixes indentation when exactly one line matches trimmed", () => {
  const sloppy = { ...edit, old: 'return {"status": "broken"}', new: 'return {"status": "ok"}' };
  const next = applyEdit(original, { ...sloppy, old: '  return {"status": "broken"}  ' });
  assert.match(next, /^    return \{"status": "ok"\}$/m);
});

test("applyEdit refuses text that is not in the file", () => {
  assert.throws(() => applyEdit("nothing here\n", edit));
});

test("applyEdit refuses an ambiguous match", () => {
  const twice = "x = 1\nx = 1\n";
  assert.throws(() => applyEdit(twice, { file: "app/a.py", old: "x = 1", new: "x = 2" }));
});

test("applyEdit refuses an ambiguous trimmed match", () => {
  const twice = "  x = 1\n\tx = 1\n";
  assert.throws(() => applyEdit(twice, { file: "app/a.py", old: " x = 1 ", new: "x = 2" }));
});

test("commentBody shows the edit as before and after", () => {
  const body = commentBody({ summary: "s", verdict: "request_changes", edit }, "note");
  assert.match(body, /Proposed edit/);
  assert.match(body, /^- {5}return \{"status": "broken"\}$/m);
  assert.match(body, /^\+ {5}return \{"status": "ok"\}$/m);
  assert.match(body, /note/);
});
