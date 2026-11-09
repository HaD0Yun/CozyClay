import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import * as motion from '../../src/studio-agent-motion.js';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? sourceFiles(url) : /\.(?:js|jsx|mjs)$/.test(entry.name) ? [url] : [];
  });
}
export const shipped = () => ['src', 'bin', 'mcp'].flatMap(path => sourceFiles(new URL(`../../${path}/`, import.meta.url)));

test('#452.3: the private candidate and installer owners are gone; installed verification remains', () => {
  const hits = shipped().flatMap(path => /createStudioMotionCandidates|commitStudioMotion/.test(readFileSync(path, 'utf8')) ? [path.pathname] : []);
  assert.deepEqual(hits, []);
  assert.deepEqual(Object.keys(motion), ['verifyInstalledTake']);
});
