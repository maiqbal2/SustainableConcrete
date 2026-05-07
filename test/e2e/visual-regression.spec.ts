import { test, expect } from "@playwright/test";

/**
 * Visual regression — full-page screenshots compared against committed
 * baselines. SKIPPED BY DEFAULT until you commit Linux baselines.
 *
 * To enable:
 *   1. Generate baselines on Ubuntu (Docker or GitHub Actions). See
 *      test/e2e/README.md for the exact docker command.
 *   2. Commit the produced files under test/e2e/__snapshots__/.
 *   3. Remove the `test.skip(...)` line below.
 *
 * Why OS-specific: font rendering, anti-aliasing, and emoji glyphs
 * differ across macOS/Linux/Windows. CI runs on ubuntu-latest, so
 * macOS-rendered screenshots will diff against it and fail.
 */
test.describe("@visual full-page snapshots", () => {
  // Remove this line once Linux baselines are committed
  test.skip(true, "visual baselines not yet committed — see test/e2e/README.md");

  test("home page", async ({ page }, testInfo) => {
    await page.goto("/");
    // Wait for charts to fully render and any animations to settle
    await page.waitForTimeout(1500);
    // Stop animations so the screenshot is deterministic
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }`,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`home-${testInfo.project.name}.png`, {
      fullPage: true,
    });
  });

  test("about modal open", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.locator("#about-link").click();
    await page.waitForTimeout(500);
    await expect(page.locator("#about-overlay")).toHaveScreenshot(
      `about-modal-${testInfo.project.name}.png`,
    );
  });
});
