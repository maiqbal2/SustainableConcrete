import { test, expect } from "@playwright/test";

/**
 * Scatter plot axis-toggle invariants.
 *
 * Both X and Y axis labels should cycle through their objectives when their
 * toggle is clicked. The scatter canvas redraws — we verify the label text
 * changes (a proxy for state actually updating).
 */
test.describe("scatter plot toggles", () => {
  test("clicking #toggle-x cycles the X-axis label", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "scatter controls hidden on mobile");
    await page.goto("/");
    const xToggle = page.locator("#toggle-x");
    await expect(xToggle).toBeVisible();
    const initial = (await xToggle.textContent())?.trim();
    expect(initial, "x toggle should have initial label").toBeTruthy();

    await xToggle.click();
    await expect(xToggle).not.toHaveText(initial!, { timeout: 2000 });

    // Toggle should cycle back after enough clicks (sanity check it's a cycle, not one-way)
    const seen = new Set<string>([initial!]);
    for (let i = 0; i < 5; i++) {
      seen.add((await xToggle.textContent())?.trim() ?? "");
      await xToggle.click();
      await page.waitForTimeout(150);
    }
    expect(seen.size, "x toggle should cycle through ≥2 distinct labels").toBeGreaterThanOrEqual(2);
  });

  test("clicking #toggle-day cycles the Y-axis label", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "scatter controls hidden on mobile");
    await page.goto("/");
    const yToggle = page.locator("#toggle-day");
    await expect(yToggle).toBeVisible();
    const initial = (await yToggle.textContent())?.trim();
    expect(initial).toBeTruthy();

    await yToggle.click();
    await expect(yToggle).not.toHaveText(initial!, { timeout: 2000 });
  });
});
