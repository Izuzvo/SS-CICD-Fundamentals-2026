# Finished Course 1 workflow

[`ci.yml`](ci.yml) is the workflow the class is aiming at.

If you fall behind during the hour:

```sh
cp course-1/solution/ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "Add the CI workflow from the course solution"
```

When this repository is published for a class, put that same file on a branch named `solution/ci` so a stuck student can check it out without hunting through the lab.
