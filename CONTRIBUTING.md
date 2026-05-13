# Contributing to SustainableConcrete
We want to make contributing to this project as easy and transparent as
possible.

## Pull Requests
We actively welcome your pull requests.

1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation.
4. Ensure the test suite passes.
5. Make sure your code lints.
6. If you haven't already, complete the Contributor License Agreement ("CLA").

## Running CI checks locally

The repo has five GitHub Actions workflows in `.github/workflows/` that
gate every PR. A `Makefile` exposes one target per workflow so "passes
locally" implies "passes on CI". Run `make help` to list them all.

### One-time setup

```bash
pip install -e ".[dev]"        # lint + Python unit tests + pre-commit
pip install -e ".[notebooks]"  # for notebook execution / validation
npm ci                         # for JS sync, e2e, lighthouse
npx playwright install --with-deps chromium  # for e2e
pre-commit install             # registers the git pre-commit hook
```

### Daily use

```bash
make check        # lint + fast tests (recommended pre-commit gate)
make format       # apply black formatting in-place
```

`make check` runs (in seconds): black, flake8, pytest with the 100%
coverage gate, the JS GP sync test, and notebook format validation.

### Before pushing — full CI parity

```bash
make check-all    # everything `make check` runs PLUS:
                  #   - execute every notebook (4-mode matrix)
                  #   - Playwright (desktop + mobile)
                  #   - Lighthouse CI
```

`make check-all` mirrors every workflow in `.github/workflows/` and is
the right command to run before a force-push. It takes several minutes.

### Individual targets

| Target                    | Mirrors workflow                               |
|---------------------------|------------------------------------------------|
| `make lint`               | `tests.yml` :lint                              |
| `make test-py`            | `tests.yml` :test                              |
| `make test-js`            | `js-sync.yml`                                  |
| `make test-notebook-fmt`  | `notebooks.yml` :notebook-lint                 |
| `make test-notebooks`     | `notebooks.yml` :mode-{dependent,independent}  |
| `make test-e2e`           | `e2e.yml`                                      |
| `make test-lighthouse`    | `lighthouse.yml`                               |

### Pre-commit hook

`.pre-commit-config.yaml` runs the same `black` and `flake8` checks
that `make lint` does, automatically on every commit. The black version
is pinned to match `pyproject.toml` and the CI workflow.

If you bump black, update all three in lockstep:
`.pre-commit-config.yaml`, the `black==X.Y.Z` constraint in
`pyproject.toml`, and re-run `make lint` to confirm.

## Contributor License Agreement ("CLA")
In order to accept your pull request, we need you to submit a CLA. You only need
to do this once to work on any of Facebook's open source projects.

Complete your CLA here: <https://code.facebook.com/cla>

## Issues
We use GitHub issues to track public bugs. Please ensure your description is
clear and has sufficient instructions to be able to reproduce the issue.

Facebook has a [bounty program](https://www.facebook.com/whitehat/) for the safe
disclosure of security bugs. In those cases, please go through the process
outlined on that page and do not file a public issue.

## License
By contributing to SustainableConcrete, you agree that your contributions will be licensed
under the LICENSE file in the root directory of this source tree.
