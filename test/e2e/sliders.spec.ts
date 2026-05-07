import { test, expect } from "@playwright/test";

/**
 * Composition sliders — minimal sanity checks. These don't pin down
 * specific predictions (that's the JS↔Python parity test in test_js_gp.mjs);
 * they just verify sliders are rendered and respond to interaction.
 */
test.describe("composition sliders", () => {
  test("desktop: at least 5 sliders are rendered with min/max labels", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop layout for sliders panel");
    await page.goto("/");
    // Wait for the dynamic slider DOM to appear
    await expect(page.locator("#sliders .slider-group").first()).toBeVisible({
      timeout: 5000,
    });
    const count = await page.locator("#sliders .slider-group").count();
    expect(count, "need ≥5 composition sliders").toBeGreaterThanOrEqual(5);
  });

  test("changing a slider triggers a strength curve redraw", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop only");
    await page.goto("/");
    await expect(page.locator("#sliders .slider-group").first()).toBeVisible();

    // Read initial pixel snapshot of the curve canvas
    const before = await page.locator("canvas#curve-canvas").screenshot();

    // Move the first slider — find the underlying <input type=range>
    const slider = page.locator('#sliders input[type="range"]').first();
    await slider.evaluate((el: HTMLInputElement) => {
      const min = Number(el.min);
      const max = Number(el.max);
      el.value = String(min + (max - min) * 0.7);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Allow render frame
    await page.waitForTimeout(300);

    const after = await page.locator("canvas#curve-canvas").screenshot();
    expect(
      Buffer.compare(before, after),
      "curve canvas should change pixels after slider input",
    ).not.toBe(0);
  });
});
