# IntelliQE CI runner

A zero-dependency headless runner that executes your IntelliQE API tests in a CI
pipeline and **fails the build when a test fails** — so a pull request is blocked
on a red API check, out of the box.

It is a thin client over one backend endpoint, `POST /api/api-automation/flows/ci-run`,
which runs a saved flow, a suite, or ad-hoc steps and returns `{ passed, exitCode, summary, junit }`.

## Requirements

- Node 18+ (uses global `fetch`) on the CI runner.
- Two environment variables:
  - `INTELLIQE_URL` — your IntelliQE base URL, e.g. `https://intelliqe.example.com`
  - `INTELLIQE_TOKEN` — a token for a user with the `api.run` permission.

## Usage

```bash
# Run one saved flow and write a JUnit report
INTELLIQE_URL=https://intelliqe.example.com \
INTELLIQE_TOKEN=xxxxx \
node ci/intelliqe-ci.mjs --flow <flowId> --junit junit.xml

# Run several saved flows as a suite, stopping at the first failure
node ci/intelliqe-ci.mjs --suite <id1,id2,id3> --stop-on-failure

# Run an ad-hoc flow from a local JSON file: { "steps": [...], "variables": {...} }
node ci/intelliqe-ci.mjs --file smoke.json
```

Copy a flow id from the **Flows** list in API Studio.

The process exits `0` when the run passed and `1` when it failed (or `2` on a
usage/connection error), which is what gates the pipeline.

## GitHub Actions

Copy [`github-action.yml`](./github-action.yml) to `.github/workflows/intelliqe.yml`.
Set repo secrets `INTELLIQE_URL` and `INTELLIQE_TOKEN`, and a repo variable
`INTELLIQE_FLOW_ID`. The workflow runs on every pull request, uploads the JUnit
report as an artifact, and fails the check when a test fails.

## GitLab CI

```yaml
intelliqe:
  image: node:20
  script:
    - node ci/intelliqe-ci.mjs --flow "$INTELLIQE_FLOW_ID" --junit junit.xml
  artifacts:
    when: always
    reports:
      junit: junit.xml
```

## Jenkins (declarative)

```groovy
stage('IntelliQE API tests') {
  environment { INTELLIQE_URL = credentials('intelliqe-url'); INTELLIQE_TOKEN = credentials('intelliqe-token') }
  steps { sh 'node ci/intelliqe-ci.mjs --flow $INTELLIQE_FLOW_ID --junit junit.xml' }
  post { always { junit 'junit.xml' } }
}
```
