import { test, expect } from "@playwright/test";

/**
 * Strength-curve readouts strip (`.readouts`): GWP, Cost, and (on desktop)
 * W/B. On mobile we hide the W/B readout so the remaining two sit on a
 * single line — wrapping them onto two rows would steal vertical space
 * from the strength curve canvas above. Pinned here so the layout can't
 * silently regress when font sizes or content change.
 */
test.describe("readouts strip", () => {
  test("desktop: GWP, Cost, and W/B are all visible", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop layout shows W/B");
    await page.goto("/");
    await expect(page.locator("#readouts")).toBeVisible();
    await expect(page.locator("#gwp-value")).toBeVisible();
    await expect(page.locator("#cost-value")).toBeVisible();
    await expect(page.locator("#wb-value")).toBeVisible();
  });

  test("mobile: W/B is hidden and the remaining readouts stay on one line", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only invariant");
    await page.goto("/");
    // The strength-curve panel is visible by default on mobile (it's the
    // top half of the dvh-split). The readouts live underneath.
    await expect(page.locator("#readouts")).toBeVisible();

    // W/B div is hidden via `.wb-readout { display: none }` on mobile.
    const wbHidden = await page.locator(".wb-readout").evaluate((el) => {
      return getComputedStyle(el as HTMLElement).display === "none";
    });
    expect(wbHidden, "`.wb-readout` should be display:none on mobile").toBe(true);

    // The visible readout `<div>`s should all sit on the same row, i.e.
    // their `top` y-coordinates are within a few pixels of each other.
    // If the strip ever wraps, the second row's `top` would jump by the
    // line height (~14px+).
    const tops = await page.locator("#readouts > div:not(.wb-readout)").evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => el.getBoundingClientRect().top),
    );
    expect(tops.length, "expected ≥ 2 visible readouts on mobile").toBeGreaterThanOrEqual(2);
    const minTop = Math.min(...tops);
    const maxTop = Math.max(...tops);
    expect(
      maxTop - minTop,
      `readouts strip wrapped (top deltas: min=${minTop}, max=${maxTop})`,
    ).toBeLessThanOrEqual(2);
  });
});
