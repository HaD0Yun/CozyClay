// Removes from dist/ what `vite build` copied out of public/ for development only, after the build: the lowvis
// demo clips (public/lowvis/), which the lowvis viewer page (lowvis/index.html) and the tests read from the dev server
// and the site and the Studio never fetch (the Studio's only reader is its QA hook). The site and the npm package then
// ship without them.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEV_ONLY = ["lowvis"];
for (const path of DEV_ONLY) rmSync(fileURLToPath(new URL(`../dist/${path}`, import.meta.url)), { recursive: true, force: true });
