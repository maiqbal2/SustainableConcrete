import { test, expect } from "@playwright/test";

/**
 * Block landing if the served strength.json has any feature lengthscale at the
 * optimiser's upper constraint bound. This mirrors
 * test/test_lengthscale_identifiability.py at the WEBSITE artifact level: the
 * Python test guards what the model script will produce; this test guards what
 * the website actually serves to users (the committed `docs/model/strength.json`).
 *
 * If a feature's lengthscale is at or near the cap, the corresponding slider
 * in the Composition panel becomes unresponsive — moving it produces no
 * visible change in the predicted strength curve. That's a silent UX failure
 * the visual tests can't catch.
 *
 * Note: feature names and the cap are read directly from the served JSON
 * (single source of truth; emitted by `scripts/export_model.py`). Missing
 * fields fail loudly so we don't silently fall back to stale local copies.
 */

test("served strength.json has identifiable lengthscales for every feature", async ({ request }) => {
  const resp = await request.get("/model/strength.json");
  expect(resp.ok(), `failed to fetch /model/strength.json: ${resp.status()}`).toBeTruthy();
  const params = await resp.json();

  const featureNames = params.feature_names as string[];
  const cap = params.lengthscale_identifiability_cap as number;
  const ls = params.matern_lengthscales as number[];

  expect(
    Array.isArray(featureNames) && featureNames.length > 0,
    `served model is missing 'feature_names'. Re-run scripts/export_model.py and commit docs/model/strength.json.`,
  ).toBeTruthy();
  expect(
    typeof cap === "number" && Number.isFinite(cap),
    `served model is missing 'lengthscale_identifiability_cap'. Re-run scripts/export_model.py and commit docs/model/strength.json.`,
  ).toBeTruthy();
  expect(
    Array.isArray(ls) && ls.length === featureNames.length,
    `expected ${featureNames.length} lengthscales, got ${ls?.length}`,
  ).toBeTruthy();

  const violations: string[] = [];
  for (let i = 0; i < featureNames.length; i++) {
    if (ls[i] >= cap) {
      violations.push(`${featureNames[i]} (idx ${i}): ${ls[i].toFixed(2)}`);
    }
  }
  expect(
    violations.length,
    `served model has feature(s) with non-identifiable lengthscales (≥ ${cap}): ${violations.join(", ")}. ` +
      `These sliders will be unresponsive in the website. Re-run scripts/export_model.py and commit the regenerated docs/model/strength.json.`,
  ).toBe(0);
});
