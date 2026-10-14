// Screenshots of the Liquid Glass theme, light and dark (not a test: no checks; run by hand).
import { browser, open, S } from "./lib.mjs";
for (const scheme of ["light", "dark"]) {
  const { page, ctx } = await open("me", "/map", { geo: [37.9755, 23.7348] });
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${S}/glass-${scheme}-map.png` });
  await page.getByRole("button", { name: "Αναφορά" }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${S}/glass-${scheme}-sheet.png` });
  await page.keyboard.press("Escape");
  await page.goto(page.url().replace("/map", "/talk"));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${S}/glass-${scheme}-talk.png` });
  await ctx.close();
}
await browser.close();
