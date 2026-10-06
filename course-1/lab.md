# Course 1 lab — CI/CD fundamentals

Work in your own public copy of this repository. Open pull requests from a branch to **your** `main`. The finished workflow is [solution/ci.yml](solution/ci.yml). If you fall behind, copy it and keep going:

```sh
cp course-1/solution/ci.yml .github/workflows/ci.yml
```

## 1. Run the app (about 15 minutes)

From the repository root:

```sh
docker build -t course-health .
docker run --rm -d --name course-health -p 8080:8080 course-health
curl -sS localhost:8080/health
docker stop course-health
```

You want `{"status": "ok"}`.

Optional, if you have Python locally:

```sh
python3 -m pip install -r requirements.txt
python3 -m pytest
```

## 2. Write the workflow (about 35 minutes)

Create a branch and replace the placeholder.

```sh
git checkout main
git pull
git checkout -b lab/pipeline
```

Open `.github/workflows/ci.yml` and replace it with the workflow you build with the instructor. It has four jobs:

1. `test` — checkout, Python 3.12, `pip install -r requirements.txt`, `python -m pytest`.
2. `secrets` — checkout with `fetch-depth: 0`, then Gitleaks.
3. `scan` — Trivy filesystem scan, high and critical, exit code 1. `requirements.txt` is what it reads.
4. `image` — runs only when the three jobs passed and the event is a pull request. It pushes `ghcr.io/<owner>/<repo>:pr-<number>` and comments the `docker pull` / `docker run` commands.

Copy the two `uses:` lines for Gitleaks and Trivy from [solution/ci.yml](solution/ci.yml). They are pinned to commits. The rest you can type.

Permissions on the workflow:

```yaml
permissions:
  contents: read
  packages: write
  pull-requests: write
```

Keep the test job's id as `test`. Course 2 listens for that name.

Commit and open the pull request:

```sh
git add .github/workflows/ci.yml
git commit -m "Add CI gates and a per-PR image"
git push -u origin HEAD
gh pr create --fill
```

## 3. Run the good pull request (about 25 minutes)

Watch the Actions tab. `test`, `secrets`, and `scan` go green, then `image` pushes and comments.

On your machine, run the commands from the comment. The short form:

```sh
gh auth token | docker login ghcr.io -u <your-github-username> --password-stdin
docker pull ghcr.io/<owner>/<repo>:pr-<number>
docker run --rm -d --name course-pr -p 8080:8080 ghcr.io/<owner>/<repo>:pr-<number>
curl -sS localhost:8080/health
docker stop course-pr
```

Use your GitHub username in `docker login`, lowercase owner and repository in the image name. GHCR packages start private. Your own token is what lets you pull. `gh auth login` needs the `read:packages` scope. If you logged in without it:

```sh
gh auth refresh -h github.com -s read:packages
```

`curl` prints `{"status": "ok"}`. That is the pull request's code, not whatever you last built by hand. Leave this pull request open until you have seen the image run. Merging is optional in class.

## 4. Make the scanners go red (about 10 minutes)

So far every gate has been green, which tells you the jobs run but not that they catch anything. This pull request gives each scanner something real to find. It is a throwaway — you will close it without merging.

```sh
git checkout lab/pipeline
git checkout -b lab/red-gates
```

Add a dependency with a known vulnerability. Versions of `requests` before 2.20.0 forward your `Authorization` header to a plain-HTTP address after an https-to-http redirect (CVE-2018-18074). It is rated high, and it is **fixed** in 2.20.0 — that second part matters, because the `scan` job ignores findings nobody has published a fix for.

```sh
echo 'requests==2.19.1' >> requirements.txt
```

Then plant a credential. Do not paste a real key anywhere: generate a fake one so nothing sensitive ever reaches your git history.

```sh
printf 'aws_access_key_id = AKIA%s\n' \
  "$(LC_ALL=C tr -dc 'A-Z0-9' < /dev/urandom | head -c 16)" > aws-credentials.ini
```

That is a random string in the shape Gitleaks looks for. The detector matches the pattern, not a list of known keys.

```sh
git add requirements.txt aws-credentials.ini
git commit -m "Add a dependency and a credentials file"
git push -u origin HEAD
gh pr create --title "Two red gates" --body "Course 1 scanner demo. Not for merge."
```

Watch all four jobs:

- `test` is **green**. `requests` installs fine and the health test still passes. A working test suite is not the same as a safe change.
- `secrets` is **red**. Gitleaks found the key.
- `scan` is **red**. Trivy names the package, the CVE, the installed version, and the version that fixes it.
- `image` is **skipped**. One red gate is enough. There is no `:pr-<number>` tag to pull.

Read the Trivy output rather than just noting the colour — the fixed-version column is the entire remediation instruction.

Then throw it away, so the fake key does not stay on your repository:

```sh
gh pr close --delete-branch
```

## 5. Open a bad pull request (about 15 minutes)

Start from `main` after the workflow exists there. If you have not merged yet, branch from `lab/pipeline` so the real workflow is present:

```sh
git checkout lab/pipeline
git checkout -b lab/broken-health
```

In `app/server.py`, change the healthy return to:

```python
def health_body():
    return {"status": "broken"}
```

```sh
git add app/server.py
git commit -m "Break the health check on purpose"
git push -u origin HEAD
gh pr create --title "Broken health check" --body "Course 1 failure demo. Leave this PR open for Course 2."
```

`test` fails. `image` does not run. There is no `:pr-<number>` tag for this pull request. Leave the pull request open. Course 2 fixes it.

## 6. What "safe to merge" means here

The checks are green, and you have run that pull request's image and seen `/health`. You still approve and merge yourself.
