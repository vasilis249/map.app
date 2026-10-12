// Renders the app icon and splash from design/icon.svg with the local Chromium (Playwright): the iOS App Store icon
// (1024 × 1024, opaque — iOS rounds the corners itself), the launch splash (2732 × 2732, light) and the web icons.
// Usage: node scripts/make-icons.mjs   (re-run after changing design/icon.svg)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
const { chromium } = createRequire("/opt/node22/lib/node_modules/")("playwright");

const svg = readFileSync(new URL("../design/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
async function render(size, html, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
  writeFileSync(out, await page.screenshot({ omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } }));
  await page.close();
}
const icon = (s) => svg.replace("<svg ", `<svg width="${s}" height="${s}" style="display:block" `);
const ios = "ios/App/App/Assets.xcassets";
await render(1024, icon(1024), `${ios}/AppIcon.appiconset/AppIcon-512@2x.png`);
// Splash: the icon (rounded, 22 %) in the middle of a light screen.
const splash = `<div style="width:2732px;height:2732px;background:#f3f0ea;display:grid;place-items:center">
  <div style="width:600px;height:600px;border-radius:134px;overflow:hidden;box-shadow:0 30px 80px rgba(10,63,158,.25)">${icon(600)}</div></div>`;
await render(2732, splash, `${ios}/Splash.imageset/splash-2732x2732.png`);
for (const n of ["-1", "-2"]) copyFileSync(`${ios}/Splash.imageset/splash-2732x2732.png`, `${ios}/Splash.imageset/splash-2732x2732${n}.png`);
await render(512, icon(512), "public/icon-512.png");
await render(180, icon(180), "public/apple-touch-icon.png");
writeFileSync("public/favicon.svg", svg);
await browser.close();
console.log("icons written");
