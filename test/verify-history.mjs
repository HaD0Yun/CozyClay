#!/usr/bin/env node
import {
	HISTORY_LIMIT,
	createHistory,
	pushHistory,
	undoHistory,
	redoHistory,
	canUndo,
	canRedo,
	createTransactions,
	beginTransaction,
	isCurrentTransaction,
	endTransaction,
	settleTransaction,
} from "../src/history.js";
import { createSceneHistoryStore } from "../src/document-store.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// A store wired to a counting spy so "onObjects not called" is assertable.
function makeStore(initial) {
	const emitted = { calls: 0, last: null };
	const store = createSceneHistoryStore(initial, {
		onObjects(next) {
			emitted.calls += 1;
			emitted.last = next;
		},
	});
	return { store, emitted };
}

/* ------------------------------------------------- stack primitives ---- */

const h0 = createHistory("a");
expect("a push of the current present creates no entry", pushHistory(h0, h0.present) === h0 && h0.past.length === 0 && h0.future.length === 0);
expect("undo on an empty history is null", undoHistory(h0) === null);
expect("redo with nothing undone is null", redoHistory(h0) === null);
expect("canUndo reads the past stack", canUndo(h0) === false);
expect("canRedo reads the future stack", canRedo(h0) === false);

const hA = pushHistory(h0, "b");
const hB = pushHistory(hA, "c");
expect("a push advances the present and keeps the past", hB.present === "c" && hB.past.length === 2);
const hUndo1 = undoHistory(hB);
const hUndo2 = undoHistory(hUndo1);
const hRedo1 = redoHistory(hUndo2);
const hRedo2 = redoHistory(hRedo1);
expect("undo/redo round-trips by reference", hUndo1.present === "b" && hUndo2.present === "a" && hRedo1.present === "b" && hRedo2.present === "c");
expect("undo is null once the past is empty", undoHistory(hUndo2) === null);
expect("redo is null once the future is empty", redoHistory(hRedo2) === null);
expect("a push after an undo clears redo", (() => {
	const pushed = pushHistory(hUndo1, "d");
	return pushed.future.length === 0 && pushed.past.length === 2 && pushed.present === "d";
})());

let capped = createHistory("v0");
for (let i = 1; i <= 60; i += 1) capped = pushHistory(capped, `v${i}`);
expect("history is capped at HISTORY_LIMIT", HISTORY_LIMIT === 50 && capped.past.length === 50, String(capped.past.length));
expect("the cap keeps the most recent entries and drops the oldest", capped.past[0] === "v10" && capped.past[49] === "v59" && capped.present === "v60");

/* ----------------------------------------- transaction coordinator ---- */

const txIdle = createTransactions();
expect("end without begin is a no-op", endTransaction(txIdle, 1) === false);
expect("settle without begin is a no-op", settleTransaction(txIdle) === null);

const tx = createTransactions();
const cancels = [];
const tokenA = beginTransaction(tx, { owner: "A", cancel: () => cancels.push("A") });
expect("beginTransaction returns the issued token", typeof tokenA === "number" && tokenA === 1);
expect("isCurrentTransaction recognises only the open token", isCurrentTransaction(tx, tokenA) === true && isCurrentTransaction(tx, 999) === false);
const tokenB = beginTransaction(tx, { owner: "B", cancel: () => cancels.push("B") });
expect("a nested begin settles the previous owner exactly once", cancels.filter((entry) => entry === "A").length === 1 && cancels.filter((entry) => entry === "B").length === 0, JSON.stringify(cancels));
expect("a stale token cannot close a newer transaction", endTransaction(tx, tokenA) === false && endTransaction(tx, tokenB) === true);

expect("settleTransaction returns the retired token and owner", (() => {
	const tx2 = createTransactions();
	const tok = beginTransaction(tx2, { owner: "Q", cancel: () => {} });
	const settled = settleTransaction(tx2);
	return settled !== null && settled.token === tok && settled.owner === "Q" && tx2.current === null;
})());

const tx3 = createTransactions();
let closeAttemptedFromInsideCancel = null;
const tokenC = beginTransaction(tx3, {
	owner: "C",
	cancel: () => {
		// The token must already be retired, so this close is inert.
		closeAttemptedFromInsideCancel = endTransaction(tx3, tokenC);
	},
});
const settledC = settleTransaction(tx3);
expect("a cancel that tries to close its own transaction is inert", closeAttemptedFromInsideCancel === false && tx3.current === null);
expect("the token is retired before cancel runs", settledC !== null && settledC.token === tokenC && settledC.owner === "C");

/* ------------------------------------------------------------- store ---- */

const s1 = makeStore(["base"]);
s1.store.applyAtomic((objects) => objects);
expect("an atomic no-op creates no entry", s1.store.depths().past === 0 && s1.emitted.calls === 0);
s1.store.applyAtomic((objects) => ["base", ...objects]);
expect("an atomic edit pushes the post-change present", s1.store.depths().past === 1 && s1.store.present() === s1.store.objects && s1.emitted.last === s1.store.objects);
expect("the present never diverges from the store (atomic)", s1.store.present() === s1.store.objects);

const s2 = makeStore(["base"]);
const token2 = s2.store.begin("gizmo", () => {});
let lastApplied = ["base"];
for (let i = 0; i < 14; i += 1) {
	lastApplied = ["base", `t${i}`];
	s2.store.applyIn(token2, () => lastApplied);
}
expect("a streamed interaction is exactly one entry", s2.store.end(token2, { commit: true }) === true && s2.store.depths().past === 1 && s2.store.depths().future === 0);
expect("the committed entry is the last applied value", s2.store.objects === lastApplied && s2.store.present() === s2.store.objects);

const s3 = makeStore(["before"]);
const token3 = s3.store.begin("plan", () => {});
const before3 = s3.store.objects;
for (let i = 0; i < 3; i += 1) s3.store.applyIn(token3, () => ["before", `d${i}`]);
expect("a cancelled interaction restores before and pushes nothing", s3.store.end(token3, { commit: false }) === true && s3.store.objects === before3 && s3.store.depths().past === 0 && s3.store.depths().future === 0);
expect("the present never diverges from the store (cancelled)", s3.store.present() === s3.store.objects);

const s4 = makeStore(["base"]);
const token4 = s4.store.begin("x", () => {});
s4.store.applyIn(token4, () => ["base", "v"]);
const firstEnd = s4.store.end(token4, { commit: true });
const secondEnd = s4.store.end(token4, { commit: true });
expect("end with a stale token returns false and changes nothing", firstEnd === true && secondEnd === false && s4.store.depths().past === 1 && s4.store.objects[1] === "v" && s4.store.present() === s4.store.objects);

const s5 = makeStore(["base"]);
const token5 = s5.store.begin("A", () => {});
s5.store.applyIn(token5, () => ["base", "mid"]);
s5.store.settle();
s5.store.applyIn(token5, () => ["base", "stale"]);
expect("a stale apply after settle is dropped", s5.store.objects[1] === "mid" && s5.store.depths().past === 1 && s5.emitted.calls === 1);

const sN = makeStore(["base"]);
const tokenN = sN.store.begin("noop", () => {});
sN.store.end(tokenN, { commit: true });
expect("an interaction with no net change creates no entry", sN.store.depths().past === 0 && sN.store.depths().future === 0);

/* ----------------------------------------------------- critic 1 ---- */
/* begin(A) -> applyIn(B1) -> begin(B) -> end(A) -> applyIn(B2) -> end(B) */

const orig6 = ["orig"];
const s6 = makeStore(orig6);
const cancels6 = [];
const token6A = s6.store.begin("A", () => cancels6.push("A"));
s6.store.applyIn(token6A, () => ["orig", "B1"]);
const token6B = s6.store.begin("B", () => cancels6.push("B"));
expect("a second begin settles the first drag into exactly one entry", cancels6.filter((entry) => entry === "A").length === 1 && s6.store.depths().past === 1 && s6.store.present() === s6.store.objects, JSON.stringify(cancels6));
const depthsBeforeStale = s6.store.depths();
expect("a stale end cannot close the newer transaction", s6.store.end(token6A, { commit: true }) === false && s6.store.depths().past === depthsBeforeStale.past && s6.store.depths().future === depthsBeforeStale.future);
s6.store.applyIn(token6B, () => ["orig", "B2"]);
expect("the newer transaction still lands after the stale end", s6.store.objects[1] === "B2");
expect("the newer transaction closes cleanly", s6.store.end(token6B, { commit: true }) === true);
expect("final depths and present are exact", s6.store.depths().past === 2 && s6.store.depths().future === 0 && s6.store.objects[1] === "B2" && s6.store.present() === s6.store.objects);
const undo61 = s6.store.undo();
expect("one undo restores B1", undo61 !== null && undo61[1] === "B1");
const undo62 = s6.store.undo();
expect("a second undo restores the original array by reference", undo62 === orig6);

/* ----------------------------------------------------- critic 1b --- */

const s7 = makeStore(["base"]);
let cancel7Runs = 0;
let close7FromInsideCancel = null;
const token7 = s7.store.begin("gizmo", () => {
	cancel7Runs += 1;
	close7FromInsideCancel = s7.store.end(token7, { commit: false });
});
s7.store.applyIn(token7, () => ["base", "mid"]);
s7.store.settle();
expect("settle runs the owner's cancel exactly once", cancel7Runs === 1);
expect("a close attempted from inside cancel is inert", close7FromInsideCancel === false && s7.store.depths().past === 1 && s7.store.present() === s7.store.objects && s7.store.objects[1] === "mid");

/* -------------------------------------------------------- undo/redo -- */

const s8a = ["a"];
const s8ab = ["a", "b"];
const s8abc = ["a", "b", "c"];
const s8 = makeStore(s8a);
s8.store.applyAtomic(() => s8ab);
s8.store.applyAtomic(() => s8abc);
const undo8 = s8.store.undo();
expect("undo restores the previous present", undo8 === s8ab && s8.store.objects === s8ab && s8.store.present() === s8.store.objects);
expect("canUndo and canRedo read the live stacks", s8.store.canUndo() === true && s8.store.canRedo() === true);
const redo8 = s8.store.redo();
expect("redo returns to it", redo8 === s8abc && s8.store.objects === s8abc && s8.store.present() === s8.store.objects);
expect("undo at the bottom is null", (() => {
	const fresh = makeStore(["x"]);
	return fresh.store.undo() === null && fresh.store.canUndo() === false;
})());
expect("redo at the top is null", (() => {
	const fresh = makeStore(["x"]);
	fresh.store.applyAtomic(() => ["x", "y"]);
	fresh.store.undo();
	fresh.store.redo();
	return fresh.store.redo() === null && fresh.store.canRedo() === false;
})());

const origU = ["orig"];
const sU = makeStore(origU);
let cancelURuns = 0;
const tokenU = sU.store.begin("gizmo", () => { cancelURuns += 1; });
sU.store.applyIn(tokenU, () => ["orig", "mid"]);
const undoU = sU.store.undo();
expect("undo mid-interaction commits then undoes that interaction", cancelURuns === 1 && undoU === origU && sU.store.objects === origU && sU.store.depths().future === 1 && sU.store.depths().past === 0);

const sM = makeStore(["orig"]);
const tokenM = sM.store.begin("gizmo", () => {});
sM.store.applyIn(tokenM, () => ["orig", "mid"]);
sM.store.applyAtomic(() => ["orig", "deleted"]);
expect("an atomic mutation mid-interaction settles first", sM.store.depths().past === 2 && sM.store.depths().future === 0 && sM.store.objects[1] === "deleted" && sM.store.present() === sM.store.objects);

const sZ = makeStore(["x"]);
expect("undo returns null with empty history and mutates nothing", sZ.store.undo() === null && sZ.store.depths().past === 0 && sZ.store.depths().future === 0 && sZ.store.present() === sZ.store.objects);

/* ----------------------------------------------------- critic 2 ---- */
/* After every operation above, with no transaction open, the public   */
/* present() getter is reference-equal to the objects getter.          */

for (const [label, { store }] of Object.entries({ s1, s2, s3, s4, s5, s6, s7, s8, sN, sU, sM, sZ })) {
	expect(`the present never diverges from the store (${label})`, store.present() === store.objects);
}

if (failures) process.exit(1);
console.log("all history checks PASS");
