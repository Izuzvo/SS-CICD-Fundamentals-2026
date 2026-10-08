# Agent contract

n8n decides. A local model writes. The model is one HTTP call, and another program can take that call if it speaks this contract.

## Request

`POST http://ollama:11434/v1/chat/completions`

No credential. Ollama has no auth, and it is reachable only on the internal Compose network.

```json
{
  "model": "<OLLAMA_MODEL>",
  "stream": false,
  "temperature": 0,
  "messages": [
    { "role": "system", "content": "<prompt from platform/prompts>" },
    { "role": "user", "content": "Diff:\n\n<unified diff>" }
  ]
}
```

The review workflow sends the diff. The fix workflow sends the full current content of each changed file under `app/`, the diff, and any failure text GitHub included on the check run. A fine-grained token cannot read check annotations, so n8n does not call that API. A small model fixes a file it can read, so n8n reads the file for it. Long inputs are cut to fit the context window (`OLLAMA_CONTEXT_LENGTH=8192`).

The prompt asks for the JSON object below. n8n still validates the reply with `parseReview` and refuses anything that does not match. Constrained decoding (`response_format`) is not used: small local models can loop and abort under it.

Chat completions is the call n8n waits on. The answer has to come back in that response. The node waits up to 300 seconds.

## Response n8n reads

n8n reads `choices[0].message.content`. That text is a JSON object:

```json
{
  "summary": "one short paragraph",
  "verdict": "request_changes",
  "edit": {
    "file": "app/server.py",
    "old": "    return {\"status\": \"broken\"}",
    "new": "    return {\"status\": \"ok\"}"
  }
}
```

`verdict` is `approve` or `request_changes`. `edit` is `null` or one `{file, old, new}` object. It is an edit, not a diff: a small model cannot count hunk line numbers, but it can copy a line and change it. Markdown fences around the object are tolerated. Any other shape is refused and no file is committed.

## What n8n will commit

A commit happens only in the CI fix workflow, and only when all of these are true:

- The check run is the job named `test`, it completed, and it failed.
- The pull request branch has no commit message containing `course bot` yet. One attempt, then a person takes over.
- `verdict` is `request_changes`.
- `edit.file` is under `app/`. Tests are off limits, so the model cannot make the check pass by weakening it. Paths with `..`, absolute paths, `tests/`, `.github/`, `platform/`, and the Dockerfile are refused.
- `edit.old` appears exactly once in that file on the branch. If it does not match, a single-line edit can still replace the one line that matches once whitespace is trimmed, and the line keeps its own indentation. Zero matches, several matches, or a wider mismatch are refused, and n8n comments why.

The commit message is `fix: restore health check (course bot)`. The push runs Course 1 again. Nobody auto-merges.

## Who holds the token, and what the model can reach

The GitHub token lives in the n8n container environment. The model receives the text n8n sends it. It does not receive the token, a checkout of the repository, or a mount of your home directory.

Ollama sits only on a Compose network marked `internal: true`, so it has no route to the internet. It publishes no host port. `OLLAMA_NO_CLOUD=1` turns off Ollama's cloud models. n8n joins both that network and a normal one, because it must reach `api.github.com`.

The prompts are [platform/prompts/review.md](../platform/prompts/review.md) and [platform/prompts/fix.md](../platform/prompts/fix.md). The checker that enforces the rules is [platform/lib/review_contract.js](../platform/lib/review_contract.js). The imported workflows are generated from those files with `node platform/n8n/build.mjs`.
