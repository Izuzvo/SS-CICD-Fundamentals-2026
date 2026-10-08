"use strict";

// Only the service code may change. Tests are off limits: a model that can
// edit tests/ can make a red check green by weakening the check.
const ALLOWED_PREFIX = /^app\//;

// Small models stop mid-string, or emit the closing braces before the closing
// quote. A quote ends a string only when what follows can legally follow one.
function repairJson(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let stringRole = "key";
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        out += c;
        escaped = false;
        continue;
      }
      if (c === "\\") {
        out += c;
        escaped = true;
        continue;
      }
      if (c === '"') {
        const rest = text.slice(i + 1);
        // "broken"}","new" — the quote before } is inside the value.
        if (/^\s*\}"/.test(rest)) {
          out += '\\"';
          continue;
        }
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        const after = text[j];
        const closes =
          after === undefined ||
          after === "," ||
          after === "}" ||
          after === "]" ||
          (stringRole === "key" && after === ":");
        if (closes) {
          inString = false;
          out += c;
        } else {
          out += '\\"';
        }
        continue;
      }
      if (c === "\n" || c === "\r") {
        out += "\\n";
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') {
      let k = out.length - 1;
      while (k >= 0 && /\s/.test(out[k])) k -= 1;
      stringRole = out[k] === ":" ? "value" : "key";
      inString = true;
      out += c;
      continue;
    }
    if (c === "{" || c === "[") stack.push(c);
    else if ((c === "}" && stack[stack.length - 1] === "{") || (c === "]" && stack[stack.length - 1] === "[")) {
      stack.pop();
    }
    out += c;
  }
  if (inString) {
    let closers = "";
    while (out.endsWith("}") || out.endsWith("]")) {
      closers = out.slice(-1) + closers;
      out = out.slice(0, -1);
    }
    let quoteAt = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] !== '"') continue;
      let slashes = 0;
      for (let k = i - 1; k >= 0 && out[k] === "\\"; k--) slashes += 1;
      if (slashes % 2 === 0) {
        quoteAt = i;
        break;
      }
    }
    const value = out.slice(quoteAt + 1);
    const pending = [];
    let valueEscaped = false;
    for (const ch of value) {
      if (valueEscaped) {
        valueEscaped = false;
        continue;
      }
      if (ch === "\\") {
        valueEscaped = true;
        continue;
      }
      if (ch === "{") pending.push("}");
      else if (ch === "[") pending.push("]");
      else if ((ch === "}" || ch === "]") && pending[pending.length - 1] === ch) pending.pop();
    }
    while (pending.length && closers.startsWith(pending[pending.length - 1])) {
      out += pending.pop();
      closers = closers.slice(1);
    }
    out += '"';
    for (const closer of closers) {
      const open = stack[stack.length - 1];
      if ((closer === "}" && open === "{") || (closer === "]" && open === "[")) {
        stack.pop();
        out += closer;
      }
    }
  }
  while (stack.length) {
    out += stack.pop() === "{" ? "}" : "]";
  }
  return out;
}

function parseReview(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Agent reply was empty.");
  }
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Agent reply did not contain a JSON object.");
  }
  const slice = stripped.slice(start, end + 1);
  let review;
  try {
    review = JSON.parse(slice);
  } catch (err) {
    try {
      review = JSON.parse(repairJson(slice));
    } catch (again) {
      throw err;
    }
  }
  if (typeof review.summary !== "string" || !review.summary.trim()) {
    throw new Error("Review JSON is missing summary.");
  }
  if (review.verdict !== "approve" && review.verdict !== "request_changes") {
    throw new Error("Review JSON verdict must be approve or request_changes.");
  }
  let edit = null;
  const raw = review.edit;
  if (raw !== null && raw !== undefined && raw !== "") {
    if (
      typeof raw !== "object" ||
      typeof raw.file !== "string" ||
      typeof raw.old !== "string" ||
      typeof raw.new !== "string"
    ) {
      throw new Error("Review JSON edit must be null or {file, old, new}.");
    }
    edit = { file: raw.file.trim(), old: raw.old, new: raw.new };
  }
  return {
    summary: review.summary.trim(),
    verdict: review.verdict,
    edit,
  };
}

// Returns the normalized path the edit may touch, or "" when there is no edit.
// Throws when the edit points anywhere it should not.
function assertSafeEdit(edit) {
  if (!edit) return "";
  const filePath = String(edit.file || "").replace(/^\.\//, "");
  if (
    !filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.split("/").includes("..") ||
    !ALLOWED_PREFIX.test(filePath)
  ) {
    throw new Error("Refusing edit path: " + (edit.file || "(empty)"));
  }
  if (typeof edit.old !== "string" || !edit.old.trim()) {
    throw new Error("Edit has no text to replace.");
  }
  if (edit.old === edit.new) {
    throw new Error("Edit changes nothing.");
  }
  return filePath;
}

function countOccurrences(text, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

// old must appear exactly once. The one concession to small models is a
// single-line edit whose only mistake is the indentation or trailing spaces:
// if exactly one line matches once trimmed, that line is replaced and keeps
// its own indentation. Anything else is refused.
function applyEdit(original, edit) {
  const hits = countOccurrences(original, edit.old);
  if (hits === 1) {
    const at = original.indexOf(edit.old);
    return original.slice(0, at) + edit.new + original.slice(at + edit.old.length);
  }
  if (hits > 1) {
    throw new Error("Edit text matches " + hits + " places. Refusing to guess.");
  }
  const oldTrim = edit.old.trim();
  const newTrim = edit.new.trim();
  if (!oldTrim.includes("\n") && !newTrim.includes("\n")) {
    const lines = original.split("\n");
    const matching = [];
    lines.forEach((line, index) => {
      if (line.trim() === oldTrim) matching.push(index);
    });
    if (matching.length === 1) {
      const index = matching[0];
      const indent = lines[index].match(/^\s*/)[0];
      lines[index] = indent + newTrim;
      return lines.join("\n");
    }
  }
  throw new Error("Edit text does not match the file.");
}

function prefixLines(text, mark) {
  return text
    .split("\n")
    .map((line) => mark + line)
    .join("\n");
}

function commentBody(review, note) {
  const fence = review.edit
    ? "\n\n**Proposed edit** in `" +
      review.edit.file +
      "`\n\n```diff\n" +
      prefixLines(review.edit.old, "- ") +
      "\n" +
      prefixLines(review.edit.new, "+ ") +
      "\n```"
    : "";
  const extra = note ? "\n\n" + note : "";
  return [
    "### Agent review",
    "",
    "**Verdict:** " + review.verdict,
    "",
    review.summary,
    fence,
    extra,
    "",
    "Posted by n8n. The model has no GitHub token and no internet access.",
  ].join("\n");
}

module.exports = {
  parseReview,
  repairJson,
  assertSafeEdit,
  applyEdit,
  commentBody,
};
