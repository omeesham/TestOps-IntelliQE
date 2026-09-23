# IntelliQE API Automation — CI integration

Run a full API suite (import → design → execute → heal → report) from your
pipeline and **fail the build on regressions**. Everything here wraps the
`intelliqe-api` CLI, which talks to the public REST API — so any CI system works.

## Secrets

| Name | Value |
|------|-------|
| `INTELLIQE_URL` | Your IntelliQE base URL, e.g. `https://intelliqe.your-company.com` |
| `INTELLIQE_TOKEN` | A token from `intelliqe-api login` or `POST /api/auth/login` |

Exit codes: `0` success · `1` usage · `2` API error · **`3` the run had failing scenarios** (this is what fails the build).

## GitHub Actions

Use the composite action in [`action.yml`](./action.yml):

```yaml
- uses: ./cli/ci                 # or: your-org/intelliqe-api-action@v1
  with:
    url:   ${{ secrets.INTELLIQE_URL }}
    token: ${{ secrets.INTELLIQE_TOKEN }}
    source: https://api.acme.com/openapi.json   # or endpoints: ./endpoints.json
    env: Staging
    coverage: standard
    layers: smoke,contract,negative,auth,flow
```

A ready-to-copy workflow (push + nightly + manual) is in
[`github-workflow.example.yml`](./github-workflow.example.yml).

## Azure Pipelines

```yaml
steps:
  - task: NodeTool@0
    inputs: { versionSpec: '20.x' }
  - script: npm i -g @intelliqe/api-cli
  - script: intelliqe-api run --url "$(SPEC_URL)" --coverage standard --wait
    env:
      INTELLIQE_URL: $(INTELLIQE_URL)
      INTELLIQE_TOKEN: $(INTELLIQE_TOKEN)
```

## GitLab CI

```yaml
api-tests:
  image: node:20
  script:
    - npm i -g @intelliqe/api-cli
    - intelliqe-api run --url "$SPEC_URL" --coverage standard --wait
  variables:
    INTELLIQE_URL: $INTELLIQE_URL
    INTELLIQE_TOKEN: $INTELLIQE_TOKEN
```

## Plain curl (no CLI)

```bash
JOB=$(curl -s -X POST "$INTELLIQE_URL/api/v1/public/api-automation/runs" \
  -H "Authorization: Bearer $INTELLIQE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"CI","source":{"kind":"url","url":"https://api.acme.com/openapi.json"},"coverage":"standard"}' \
  | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).data.jobId))')

# then poll GET /api/v1/public/api-automation/runs/$JOB until status is done, and
# inspect the result's pass/fail counts to decide the exit code.
```

> These are templates, not active workflows — copying `action.yml` and the example
> into a repo's `.github/` is what activates them.
