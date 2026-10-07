// Make the compiled entrypoints executable so `npx gutenberg-mcp` works.
import { chmodSync } from "node:fs";

for (const file of ["index.js", "http.js"]) chmodSync(new URL(`../dist/${file}`, import.meta.url), 0o755);
