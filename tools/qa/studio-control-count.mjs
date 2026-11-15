// Count what the Studio shows at once per workflow mode, screenshot each
// state, and hold the "controls" count to the v2 budgets (docs/studio-ui-ia.md §1).
//
//   QA_URL=http://127.0.0.1:5180/app/?motion=/demo/walk-then-stop.npz CDP_PORT=9241 OUT=/tmp/studio-count \
//     node tools/qa-browser.mjs -- node tools/qa/studio-control-count.mjs
//
// Writes <OUT>-<state>.png and <OUT>-counts.json (default OUT /tmp/studio-count)
// and exits 1 when any state has more controls than its budget.
//
// Every rendered button/select/range/checkbox/a.topbar-action with a non-zero
// box is counted (CSS display:none does not count, hover-revealed chevrons do)
// and split in two:
//   items    - data, which grows with the project: Outliner tree rows and their
//              disclosure carets, Content asset tiles and Content category rows;
//   controls - everything else (chrome). Only controls have a budget.
// "total" (= controls + items) is the pre-v2 metric the R6 targets used.

// v2 baseline measured on 40767ed (motion 55 -> 52 after #550 moved generate to the top bar); the pre-v2 R6 targets were 35/45/38/52 (docs/studio-ui-ia.md §1).
const BUDGETS = { "stage-none": 37, "stage-char": 45, pose: 58, camera: 39, motion: 52 };

import { writeFileSync } from "node:fs";

const OUT = process.env.OUT || "/tmp/studio-count";
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result?.value; };
// A MutationObserver armed before the check resolves on the exact DOM state.
const waitFor = (expression, timeoutMs = 20000) => ev(`new Promise((resolve, reject) => {
  const test = () => { try { return Boolean(${expression}); } catch { return false; } };
  if (test()) { resolve(true); return; }
  const observer = new MutationObserver(() => { if (!test()) return; observer.disconnect(); clearTimeout(timer); resolve(true); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`Timed out waiting for: ${expression}`)})); }, ${timeoutMs});
})`);
const settle = () => ev("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");

await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
if (process.env.QA_URL) await send("Page.navigate", { url: process.env.QA_URL });
await waitFor("!!(window.__cozyclay && window.__cozyclay.rigA && window.__cozyclay.editorCam) && !!document.querySelector('[data-mode-key]') && !!document.querySelector('[data-node-id=characterA] .hierarchy-row')", 60000);
await ev("window.__cozyclay.pause?.(); true");

const COUNT = `(()=>{
  const vis=(el)=>{const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;const s=getComputedStyle(el);return s.visibility!=="hidden"&&s.display!=="none"&&s.opacity!=="0";};
  const all=[...document.querySelectorAll("button, select, input[type=range], input[type=checkbox], a.topbar-action")].filter(vis);
  const isItem=(el)=>(!!el.closest("[role=treeitem]")&&(el.classList.contains("hierarchy-row")||el.classList.contains("hierarchy-toggle")))
    ||el.matches("[data-testid=content-asset], [data-testid^=content-folder-]");
  const region=(el)=>{
    if(el.closest("header.topbar"))return "topbar";
    if(el.closest(".v2-outliner, .hierarchy-left"))return "outliner";
    if(el.closest(".inspector-sidebar, .inspector"))return "details";
    if(el.closest(".v2-sequencer, .timeline"))return "sequencer";
    if(el.closest("[data-testid=content-browser], .bottom-dock"))return "content";
    if(el.closest(".v2-statusbar, .brandbar"))return "statusbar";
    if(el.closest(".viewport"))return "viewport";
    return "other:"+(el.closest("aside, section, div[class]")?.className||"").toString().slice(0,30);
  };
  const name=(el)=>(el.getAttribute("aria-label")||el.textContent||el.tagName).trim().replace(/\\s+/g," ").slice(0,24);
  const by={controls:{},items:{}};let controls=0,items=0;
  for(const el of all){const kind=isItem(el)?"items":"controls";if(kind==="items")items+=1;else controls+=1;(by[kind][region(el)]??=[]).push(name(el));}
  const pose=document.querySelector(".pose-details");
  const poseDetails=pose?[...pose.querySelectorAll("button,select,input[type=range],input[type=checkbox]")].filter(vis).length:null;
  return {controls,items,total:all.length,poseDetails,by};
})()`;

const mode = async (key) => {
  await ev(`document.querySelector('[data-mode-key="${key}"]').click(); true`);
  await waitFor(`document.querySelector('[data-mode-key="${key}"]')?.getAttribute('aria-selected') === 'true'`);
};
const selectCharacter = async () => {
  await ev("document.querySelector('[data-node-id=characterA] .hierarchy-row').click(); true");
  await waitFor("document.querySelector('[data-node-id=characterA]')?.getAttribute('aria-selected') === 'true'", 5000);
};
const states = [
  ["stage-none", async () => { await mode("1"); await ev("window.__cozyclay.selectHierarchy?.(null); true"); }],
  ["stage-char", async () => { await mode("1"); await selectCharacter(); }],
  // Pose as #545 measures it: press 2, IK turns on, Pose Details renders.
  ["pose", async () => { await mode("2"); await waitFor("window.__cozyclay.ikMode === true && !!document.querySelector('.pose-details')"); }],
  ["camera", async () => { await mode("3"); }],
  ["motion", async () => { await mode("4"); await selectCharacter(); }],
];
const out = {};
const over = [];
for (const [name, setup] of states) {
  // A build without a Motion mode tab skips the measure.
  if (name === "motion" && !(await ev("!!document.querySelector('[data-mode-key=\"4\"]')"))) { console.log("SKIP motion (no Motion mode in this project)"); continue; }
  await setup(); await settle();
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}-${name}.png`, Buffer.from(shot.data, "base64"));
  out[name] = { ...await ev(COUNT), budget: BUDGETS[name] };
  const ok = out[name].controls <= BUDGETS[name];
  if (!ok) over.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} controls ${out[name].controls} <= ${BUDGETS[name]} (items ${out[name].items}, total ${out[name].total})`);
}
writeFileSync(`${OUT}-counts.json`, JSON.stringify(out, null, 2));
ws.close();
if (over.length) console.log(`over budget: ${over.join(", ")}`);
process.exit(over.length ? 1 : 0);
