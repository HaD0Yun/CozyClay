// Reuse the existing integration fixture, which evaluates App's actual native
// functions over its real stores and rigs. Do not run its unrelated cases here.
import { readFileSync } from 'node:fs';
const url = new URL('../verify-studio-agent-binding.mjs', import.meta.url);
let source = readFileSync(url, 'utf8').split('const implementations={')[0];
source = source.replaceAll('import.meta.url', JSON.stringify(url.href))
  .replace(/(from\s*|import\()(['"])([^'"]+)\2/g, (_all, prefix, quote, path) => `${prefix}${quote}${path.startsWith('.') ? new URL(path, url).href : import.meta.resolve(path)}${quote}`)
  .replace('return {render,rendered:', 'return {actionHandlers,render,rendered:');
const module = await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { fixture, parsed, app, parseSync };`).toString('base64')}`);
export const appFixture = module.fixture;
export const appProgram = module.parsed.program;
export const appSource = module.app;
export const parseJavaScript = module.parseSync;
