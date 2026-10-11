// Before `cap sync ios`: small patches to native plugins (pinned versions; each patch is idempotent).
// 1. @capacitor-community/background-geolocation 1.2.26 declares capacitor-swift-pm `from: "7.0.0"` (= 7.x only in
//    SPM), which can't resolve next to the app's exact 8.5.2. The Swift code itself works with Capacitor 8.
// 2. Same plugin: if the user turned off "Precise Location" (iOS 14+ reduced accuracy, fixes off by kilometres), ask
//    iOS for temporary full accuracy like Find My does (purpose key "PreciseMap" in Info.plist
//    NSLocationTemporaryUsageDescriptionDictionary). Only asked once the app is authorized. The plugin targets iOS 13,
//    so the iOS 14 API sits behind `#available` (an older patch without it is upgraded in place).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PLUGIN = "node_modules/@capacitor-community/background-geolocation";
const FULL_ACCURACY = (indent) =>
  `${indent}if #available(iOS 14.0, *), manager.accuracyAuthorization == .reducedAccuracy {\n` +
  `${indent}    manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "PreciseMap")\n` +
  `${indent}}\n`;

const patches = [
  {
    file: `${PLUGIN}/Package.swift`,
    from: /capacitor-swift-pm\.git",\s*from:\s*"7\.0\.0"/,
    to: 'capacitor-swift-pm.git",\n            from: "8.0.0"',
  },
  {
    // addWatcher: reached only when already authorized (or permissions not requested).
    file: `${PLUGIN}/ios/Plugin/Swift/Plugin.swift`,
    done: "withPurposeKey",
    from: /^( {12})return watcher\.start\(\)$/m,
    to: (_m, indent) => `${FULL_ACCURACY(indent)}${indent}return watcher.start()`,
  },
  {
    // didChangeAuthorization: right after the user allowed location.
    file: `${PLUGIN}/ios/Plugin/Swift/Plugin.swift`,
    done: "status == .authorizedAlways || status == .authorizedWhenInUse",
    from: /^( {16})return watcher\.start\(\)$/m,
    to: (_m, indent) =>
      `${indent}if status == .authorizedAlways || status == .authorizedWhenInUse {\n` +
      `${FULL_ACCURACY(indent + "    ")}${indent}}\n${indent}return watcher.start()`,
  },
  {
    // Files patched by the first version (no availability check → "only available in iOS 14.0 or newer").
    file: `${PLUGIN}/ios/Plugin/Swift/Plugin.swift`,
    from: /if manager\.accuracyAuthorization == \.reducedAccuracy \{/g,
    to: "if #available(iOS 14.0, *), manager.accuracyAuthorization == .reducedAccuracy {",
  },
];

for (const p of patches) {
  if (!existsSync(p.file)) continue;
  const src = readFileSync(p.file, "utf8");
  if ((p.done && src.includes(p.done)) || !src.match(p.from)) continue;
  writeFileSync(p.file, src.replace(p.from, p.to));
  console.log(`patched ${p.file}`);
}
