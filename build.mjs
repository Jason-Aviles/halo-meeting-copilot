import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";

const common = { bundle: true, sourcemap: true, logLevel: "info", target: "es2022" };

mkdirSync("dist/renderer", { recursive: true });

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    platform: "node",
    format: "cjs",
    // ws loads these optional native speedups only if present.
    external: ["electron", "bufferutil", "utf-8-validate"],
  }),
  build({
    ...common,
    entryPoints: ["src/preload/preload.ts"],
    outfile: "dist/preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/renderer/renderer.ts"],
    outfile: "dist/renderer/renderer.js",
    platform: "browser",
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: ["src/renderer/pcm-worklet.ts"],
    outfile: "dist/renderer/pcm-worklet.js",
    platform: "browser",
    format: "iife",
  }),
]);

cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/styles.css", "dist/renderer/styles.css");

// The native add-on is optional: without it, Halo runs without echo cancellation.
const nativeAddon = "native/out/paracat-native.win32-x64-msvc.node";
if (existsSync(nativeAddon)) cpSync(nativeAddon, "dist/paracat-native.node");
else console.warn(`${nativeAddon} not found. Run "npm run build:native" for echo cancellation in Halo.`);
