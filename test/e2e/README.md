# End-to-end tests for the BOxCrete website

These Playwright specs pin down the **design and behavioral invariants**
of the interactive site at `docs/`. Every spec corresponds to at least
one named invariant — when you find yourself manually checking a
property on a PR, add a spec for it before merging.

## Invariants currently covered

| Spec file                     | Invariant                                                                 | Project(s) |
|-------------------------------|---------------------------------------------------------------------------|------------|
| `home-loads.spec.ts`          | Home page loads with no console/page errors and core canvases visible     | desktop+mobile |
| `home-loads.spec.ts`          | Strength curve canvas renders within a few seconds of load                | desktop+mobile |
| `header-layout.spec.ts`       | Theme toggle is the rightmost element in the header                       | desktop+mobile |
| `header-layout.spec.ts`       | On desktop, cite group is to the left of the theme toggle and not overlapping | desktop |
| `header-layout.spec.ts`       | On mobile, cite group is hidden                                           | mobile |
| `header-layout.spec.ts`       | On mobile, the 5 visible header items are evenly spaced (gap deltas < 6px) | mobile |
| `header-layout.spec.ts`       | Header stays sticky at the top of the viewport when scrolling             | desktop+mobile |
| `header-layout.spec.ts`       | No horizontal scroll on mobile (drag pan is locked)                       | mobile |
| `scatter-toggle.spec.ts`      | X-axis label cycles when `#toggle-x` is clicked                           | desktop |
| `scatter-toggle.spec.ts`      | Y-axis label cycles when `#toggle-day` is clicked                         | desktop |
| `mobile-panel-toggle.spec.ts` | Tapping "Composition" hides scatter content and shows sliders             | mobile |
| `mobile-panel-toggle.spec.ts` | Tapping "Performance Tradeoffs" hides sliders and shows scatter           | mobile |
| `theme-toggle.spec.ts`        | Theme toggle flips `data-theme` attribute on `<html>`                     | desktop+mobile |
| `theme-toggle.spec.ts`        | Theme choice persists across reload via localStorage                      | desktop+mobile |
| `about-modal.spec.ts`         | About modal opens on link click and closes on `Escape`                    | desktop+mobile |
| `about-modal.spec.ts`         | About modal closes on overlay click and on the × button                   | desktop+mobile |
| `sliders.spec.ts`             | At least one slider is rendered with min/max labels                       | desktop |
| `visual-regression.spec.ts`   | Full-page screenshot matches committed baseline (skipped by default)      | desktop+mobile |

## Running

```bash
# install deps + browsers (first time)
npm install
npx playwright install --with-deps chromium

# run all tests
npm run test:e2e

# run only mobile project
npm run test:e2e -- --project=mobile

# headed (watch the browser)
npm run test:e2e:headed

# interactive debugger
npm run test:e2e:ui

# show last HTML report
npm run test:e2e:report
```

## Updating visual snapshots

Visual regression snapshots are **OS-specific** — fonts and anti-aliasing
differ between macOS, Linux, and Windows. CI runs on Ubuntu, so the
snapshots committed must be Linux-rendered.

To regenerate baselines:

1. **Locally (recommended)** — run in the official Playwright Docker image:
   ```bash
   docker run --rm --network host -v $(pwd):/work -w /work \
     mcr.microsoft.com/playwright:v1.48.0-jammy \
     bash -c "npm ci && npm run test:e2e:update -- --grep @visual"
   ```
2. **Via GitHub Actions** — manually dispatch the `e2e` workflow with
   `update_snapshots: true` and commit the resulting artifact.

Visual specs are tagged `@visual` and skipped by default. Enable them
once you have committed Linux baselines.

## Adding a new invariant

1. Decide which spec file it belongs in (or create a new one with a clear name).
2. Write the test as a single `test('<plain-English invariant>', ...)`.
3. Use `testInfo.project.name` to scope to desktop/mobile when needed.
4. Add a row to the table above.
5. Run locally to confirm it passes.
6. PR it.

## Anti-patterns to avoid

- **`page.waitForTimeout` longer than 500ms** — replace with `expect(...).toPass()`
  or `waitForFunction` to wait for the actual condition. Long fixed waits
  are slow on CI and still flaky.
- **Tests that retry to mask flakiness** — fix the race condition. CI retries
  exist for transient infrastructure issues, not for "sometimes the animation
  hasn't finished".
- **Tests with no plain-English description** — every test should pin down
  one named property. If you can't name it, you don't need it yet.
- **Tests that don't fail when the feature breaks** — write the assertion
  first, break the feature, confirm the test fails, then fix the feature.
