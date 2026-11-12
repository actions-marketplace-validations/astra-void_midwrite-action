# Midwrite GitHub Action

Runs [Midwrite](https://github.com/astra-void/midwrite) on every pull
request. It looks for places in TypeScript backends where a crash or failed
call between two separately committed side effects leaves the system
half-done, for example a paid order whose `order.completed` event was never
published.

On a pull request, the action:

1. analyzes the base commit and records each finding's fingerprint;
2. analyzes the pull request with that baseline, so only findings the pull
   request **adds** count;
3. uploads SARIF to GitHub code scanning;
4. keeps **one** comment on the pull request listing the new findings, and
   updates it on every push (no comment when there is nothing new);
5. fails the check only when a new finding reaches `fail-on`.

> **Experimental (Midwrite 0.1.0).** Supported: TypeScript with Drizzle ORM
> on PostgreSQL. A finding is a potential partial-failure window, not a
> confirmed bug: in evaluation, about half of real windows were deliberate
> (retries, best-effort sends). Read
> [what a warning means](https://github.com/astra-void/midwrite#what-a-warning-means).

## Usage

```yaml
name: midwrite
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write   # SARIF upload
  pull-requests: write     # the pull request comment

jobs:
  midwrite:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astra-void/midwrite-action@v0
```

Put a `midwrite.json` at the repository root to tell Midwrite which names
are your database handle and which calls are side effects
([configuration](https://github.com/astra-void/midwrite/blob/main/docs/reference/configuration.md)).
The pull request's configuration is used for the base commit too, so
changing the configuration alone never creates "new" findings.

On `push`, there is no base to compare with: every finding counts, and
SARIF is uploaded so code scanning can track alerts on the branch.

## Inputs

| input | default | |
| --- | --- | --- |
| `version` | `0.1.0` | midwrite npm package version |
| `paths` | `.` | files or directories, space-separated |
| `working-directory` | `.` | where to run (monorepos) |
| `config` | `midwrite.json` if present | configuration file |
| `policy` | `recommended` | `recommended`, `strict` or `audit` |
| `fail-on` | `warning` | fail when a **new** finding reaches `error`, `warning`, `info`, or `never` |
| `comment` | `true` | keep a pull request comment with new findings |
| `comment-severity` | `warning` | lowest severity listed in the comment; lower ones are counted |
| `upload-sarif` | `true` | upload to code scanning (public repositories, or GitHub Advanced Security) |
| `github-token` | `github.token` | token for the comment |

## Outputs

| output | |
| --- | --- |
| `new-findings` | findings the pull request adds, all severities |
| `exit-code` | `midwrite check` exit status |
| `json-file`, `sarif-file` | report paths |

## Notes

* Pull requests from forks get a read-only token, so the comment is skipped
  with a warning; the check and SARIF still work.
* Code scanning uploads need a public repository or GitHub Advanced
  Security. Set `upload-sarif: false` otherwise.
* Runs on Linux, macOS and Windows runners. On Windows only static analysis
  is available, which is all this action uses.

## License

MIT OR Apache-2.0, at your option.
