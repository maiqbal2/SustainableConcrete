import { test, expect } from "@playwright/test";

/**
 * Mobile-only: the unified panel switches between scatter and sliders
 * via two tab buttons (#mobile-show-scatter / #mobile-show-sliders).
 * After a 300ms crossfade, the inactive view should be hidden.
 */
test.describe("mobile panel toggle", () => {
  test("initial state: scatter visible, sliders hidden, scatter button active", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    await page.goto("/");
    await expect(page.locator("#mobile-show-scatter")).toHaveClass(/active/);
    await expect(page.locator(".scatter-content")).toBeVisible();
    await expect(page.locator(".mobile-sliders-view")).toBeHidden();
  });

  test("tapping Composition shows sliders and hides scatter", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    await page.goto("/");
    await page.locator("#mobile-show-sliders").click();
    // Wait through the 300ms crossfade
    await expect(page.locator("#mobile-show-sliders")).toHaveClass(/active/);
    await expect(page.locator(".mobile-sliders-view")).toBeVisible({ timeout: 2000 });
    await expect(page.locator(".scatter-content")).toBeHidden();
  });

  test("tapping Performance Tradeoffs returns to scatter", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    await page.goto("/");
    // Switch to sliders first
    await page.locator("#mobile-show-sliders").click();
    await expect(page.locator(".mobile-sliders-view")).toBeVisible();
    // Switch back
    await page.locator("#mobile-show-scatter").click();
    await expect(page.locator(".scatter-content")).toBeVisible({ timeout: 2000 });
    await expect(page.locator(".mobile-sliders-view")).toBeHidden();
  });
});
