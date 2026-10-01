import fs from "node:fs";

const entryPath = new URL("../dist/ui/index.js", import.meta.url);
const source = fs.readFileSync(entryPath, "utf8");
const relativeImport = /(?:from|import)\s*(?:\(\s*)?["']\.\//.exec(source);

if (relativeImport) {
  console.error(
    "dist/ui/index.js contains a relative import. Paperclip loads this entry from a blob: URL, which cannot resolve it.",
  );
  process.exit(1);
}
