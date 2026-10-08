# Course 2 lab — AI-powered pipelines

Two hours. The repository from Course 1 stays. You connect GitHub to n8n, watch a review comment, then watch a failed test turn into a commit. You still merge.

Read [contract.md](contract.md) before you import anything. The workflows are already drawn. Your job is to point them at your repository and fire one bad pull request.

## 1. Load the local model

The model runs in a container on your laptop. No account, no API key, no quota. You download it once, before the first `docker compose up`, and it stays in a Docker volume.

From `platform/`:

```sh
cp .env.example .env
docker compose --profile setup run --rm model-pull
```

`model-pull` is the only container allowed to reach the internet for this. It downloads the model named by `OLLAMA_MODEL` in `.env` (default `qwen2.5-coder:3b`, about 1.9 GB), prints `ollama list`, and exits. If your laptop is slow, set `OLLAMA_MODEL=qwen2.5-coder:1.5b` in `.env` before you run it. The smaller model is quicker and makes more mistakes.

## 2. Secrets

Still in `platform/`. Fill `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` in `.env`.

`GITHUB_TOKEN` is a fine-grained personal access token, limited to this repository and nothing else. Under **Permissions → Repository permissions** set exactly these:


| Permission        | Access         | Why                                                             |
| ----------------- | -------------- | --------------------------------------------------------------- |
| **Contents**      | Read and write | commit the model's edit to the pull request branch              |
| **Pull requests** | Read and write | post the review comment                                         |
| **Metadata**      | Read           | required on every fine-grained token; GitHub selects it for you |


Generate `GITHUB_WEBHOOK_SECRET` with:

```sh
openssl rand -hex 20
```

Leave `WEBHOOK_URL` empty for now. The public URL comes from the tunnel in the next step, after n8n is listening.

## 3. Start the stack

Still in `platform/`:

```sh
docker compose up -d
docker compose ps
docker compose exec ollama ollama list
```

`docker compose ps` shows n8n on `127.0.0.1:5678` and no host port for Ollama. `ollama list` shows your model.

Warm the model up. The first answer is the slow one because the weights load into memory. Use the model name from `.env`:

```sh
docker compose exec ollama ollama run qwen2.5-coder:3b "reply ok"
docker compose exec ollama ollama ps
```

`ollama ps` should say `100% CPU`. Docker Desktop on a laptop has no GPU, so expect tens of seconds for a short answer and a minute or two for the fix prompt. The model stays loaded (`OLLAMA_KEEP_ALIVE=-1`), so later calls skip the load.

Now check the boundary. The model container has no route to the internet, so it cannot download anything:

```sh
docker compose exec ollama ollama pull tinyllama
```

That fails with a network error. It is meant to. The agent can read what n8n sends it and nothing else. Nothing else on your laptop is reachable from it either, because the compose file mounts no host directory and no Docker socket.

```sh
curl -sS -m 3 http://127.0.0.1:11434/api/tags || true
```

That curl fails too. The model port exists only on the internal Compose network, where n8n calls `http://ollama:11434`.

Open `http://127.0.0.1:5678` and create the n8n owner user. That login is what sits behind the tunnel.

In a second terminal, point a tunnel at the n8n port. No account:

```sh
cloudflared tunnel --url http://127.0.0.1:5678
```

It prints an `https://….trycloudflare.com` URL. Copy it, including the trailing slash, into `WEBHOOK_URL`. n8n reads that variable when the container starts, so recreate it:

```sh
docker compose up -d --force-recreate n8n
```

Leave `cloudflared` running. Restarting it prints a new URL. If that happens after step 5, update `WEBHOOK_URL`, recreate n8n, and change the Payload URL on each of the two webhooks you added in the GitHub repository: the Pull requests one and the Check runs one.

## 4. Import and activate

These are two workflows, not one. Import each file into its own blank workflow:

1. Create a new workflow
  1. In the upper-right corner, click the three dots (...) and choose `Import from file`.
  2. Pick `platform/n8n/pr-review.json`. n8n names this workflow **PR review**.
  3. Save the workflow.
2. Create a new workflow again.
  1. Import `platform/n8n/ci-fix.json` the same way. n8n names this workflow **CI fix**.
  2. Save the workflow.

Do not import the second file into the first workflow. That replaces it.

Open each workflow and turn it on with the **Active** toggle. Activation is what makes the production webhook answer. On each workflow, open the Webhook node and copy the **Production** URL. They look like:

- `https://<your-tunnel>/webhook/github-pr`
- `https://<your-tunnel>/webhook/github-check`



## 5. Two GitHub webhooks

In the repository: 

1. Settings > Webhooks > Add webhook. 
2. Payload URL = The production URL from n8n
3. Content type = `application/json`. 
4. Secret = `GITHUB_WEBHOOK_SECRET`. 
5. Enable SSL verification.

- PR review listens for **Pull requests** at the `github-pr` production URL.
- CI fix listens for **Check runs** at the `github-check` production URL.

Send yourself the ping (GitHub sends the ping automatically when creating the webhook). n8n should show an execution that ends on Ignore event. A red execution here means the secret or the raw body does not match. Compare the secret, then `docker compose up -d --force-recreate n8n`.

## 6. Open a new bad pull request

GitHub does not replay an `opened` event from Course 1. Branch from the commit that already contains the finished workflow (`pr-test`, or `main` if you merged it). If you branch from `main` while it still has the placeholder workflow, the check that runs is not named `test`, and the fixer does not start.

After both workflows are active, check out the pipeline branch and break `health_body`:

```sh
git switch main  # to ensure we are in main
git checkout -b lab/ai-fix # creates a new branch
```

In `app/server.py`:

```python
def health_body():
    return {"status": "broken"}
```

```sh
git add app/server.py
git commit -m "Break the health check for the agent"
git push -u origin HEAD
gh pr create --fill
```

Watch, in this order:

1. The PR review execution in n8n, then a comment on the pull request.
2. The `test` check going red. `image` skipped.
3. The CI fix execution. The model call is the slow node: allow a few minutes on a CPU. A second comment, then a commit `fix: restore health check (course bot)` on the branch.
4. Actions running again. When `image` is green, `docker pull` that `:pr-<number>` tag again and curl `/health`, the same commands as Course 1. Pull again so you do not run a cached image.

If a `course bot` commit is already on the branch, the fixer comments and stops. That is the loop guard. One attempt.

## 7. The swap point

Open the **Ask model** node. The URL is `http://ollama:11434/v1/chat/completions` and there is no credential. The body is the contract in [contract.md](contract.md). Replacing the model means another service that answers the same call and returns `choices[0].message.content` as that JSON object. A hosted model needs an API key and a network route out of the `ai` network, which is the trade you would be making. The GitHub token stays in n8n either way.

To try another local model, change `OLLAMA_MODEL` in `.env`, run `docker compose --profile setup run --rm model-pull`, then `docker compose up -d --force-recreate n8n`.

If the fix comment says the reply could not be read, or that n8n could not apply the edit, the model answered wrongly. That is the lesson about small models: n8n refused to commit a guess. Open a fresh pull request and try again, or move to a bigger model.

## Rules for this laptop

- Run the model only as this container. Do not run the host installer.
- Do not mount your home directory, `~/.ssh`, `~/.aws`, or the Docker socket into any container.
- Do not publish port 11434, and do not point the tunnel at it.
- Do not move Ollama off the `ai` network. That network is what keeps it offline.
- Do not give the model the GitHub token.
- Do not auto-merge.

