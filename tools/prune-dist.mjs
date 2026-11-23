// Removes from dist/ what `vite build` copied out of public/ for development only, after the build: everything under
// public/lowvis/, which is the tracked demo clips and the clips the motion runs of this checkout wrote
// (public/lowvis/clips/pi, ignored by git). The lowvis viewer page (lowvis/index.html), the recorders and the tests read
// them from the dev server, which serves public/ itself; the site and the Studio never fetch them (the Studio's only
// reader is its QA hook, which answers false without one). The site and the npm package then ship without them:
// `npm run build` is the one build every caller goes through (CI, the Pages deploy, prepack, prepublishOnly), and
// tools/verify-package-tarball.mjs refuses a tarball that still has them.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEV_ONLY = ["lowvis"];
for (const path of DEV_ONLY) rmSync(fileURLToPath(new URL(`../dist/${path}`, import.meta.url)), { recursive: true, force: true });
