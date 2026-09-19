import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(root, "editor-src/editor-main.js")],
  bundle: true,
  format: "iife",
  globalName: "ThreadTermCodeEditor",
  target: ["es2022"],
  outfile: path.join(root, "vendor/editor.bundle.js"),
  sourcemap: true,
  minify: false,
});
