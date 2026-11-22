// The checks of test/lowvis/qa-install-browser.mjs (its header says how they run): what the motion tool installs, when,
// and what survives it, in a real Studio. QA_ONLY=undo,cases,outlive,place,size runs some of them.
const diff = (a, b, path = "", out = []) => {
	if (JSON.stringify(a) === JSON.stringify(b)) return out;
	if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out); return out; }
	out.push(`${path}: ${String(JSON.stringify(a)).slice(0, 120)} -> ${String(JSON.stringify(b)).slice(0, 120)}`);
	return out;
};
const NOTE = { en: "The motion this turn started was not stopped: nothing more of it is installed until a later message of yours asks for it or asks to stop it.", ko: "이 턴에서 시작한 모션 작성은 중지되지 않았어요. 다음 메시지에서 모션을 요청하거나 중지를 요청하기 전까지는 더 설치되지 않아요." };
const HINT = { en: /^This motion was made for scale 1; the body is now [\d.]+, so the motion plays scaled and its contacts may be off\. Ask the agent to fit the motion to this size\.$/, ko: /^이 모션은 크기 1에 맞춰 만든 거예요\. 지금 몸 크기\([\d.]+\)와 달라서 모션이 비율만 바뀐 채 재생되고 접촉이 어긋날 수 있어요\. 에이전트에게 모션을 이 크기에 맞춰 달라고 요청하세요\.$/ };
const TOAST = { en: "The motion was made for the old size. Ask the agent to fit it to the new one.", ko: "모션은 이전 크기에 맞춰 만든 거예요. 에이전트에게 새 크기에 맞춰 달라고 요청하세요." };

export async function scenarios(t) {
	const { ID, turn, stop, act, snapshot, last, writer, agent, gate, sleep, click, say, idle, waitFor, evaluate, panelShot, shot, pass, report, wants, assert, send, locale } = t;
	const equal = async (before, label) => { const d = diff(before, await snapshot()); assert.deepEqual(d, [], `${label}: ${d.join(" | ")}`); };
	const answer = results => results.filter(r => r.name === "motion_result" && !r.isError && r.value.draft !== true).at(-1)?.value;
	const undone = results => results.filter(r => r.name === "undo_edit");
	const cupOf = scene => scene.objects.find(o => o.name === "cup"), takeOf = scene => scene.characters.find(c => c.id === ID).take;
	// its six numbers on the bone, to a millionth (a duplicate of a scene stores a turn within 1e-13 of the first)
	const place = o => ["x", "y", "z", "rotX", "rot", "rotZ"].map(k => Math.round(o[k] * 1e6) / 1e6);
	const install = async (plan, words = "lift the cup") => { writer.plan = plan; return answer(await turn(words, [["motion"], ["result"], ["result"]])); };
	// a turn that starts a motion and is stopped by the user while its model thinks (the writer goes on). wind: false
	// leaves the stopped run winding down (its model call has not returned) until the answer's wind() is called
	const startAndStop = async (words, gateName, { wind = true } = {}) => {
		const from = agent.results.length;
		await turn(words, [["motion"], ["gate", gateName]], { wait: false });
		await waitFor(() => agent.results.slice(from).some(r => r.name === "motion" && r.value?.started === true), "the motion started");
		await stop();
		const end = async () => { gate(gateName).open(); await sleep(400); };
		if (wind) await end();
		return { wind: end };
	};
	const stoppedNote = () => evaluate("[...document.querySelectorAll('.agent-steps-note')].at(-1)?.textContent ?? ''");

	// --- row 4: the receipts of an install undo exactly that install; a later turn cannot use them -----------------------
	if (wants("undo")) {
		const s0 = await snapshot();
		// the first install, taken back in its own turn: what is left is the draft's stand-ins (made before the install, under their own edits)
		writer.plan = { end: "report", variant: 0 };
		let r = await turn("lift the cup", [["motion"], ["result"], ["result"], ["undo"]]);
		const first = answer(r);
		assert.equal(first.installed, true);
		assert.ok(first.undo.length >= 2 && undone(r).length === first.undo.length && undone(r).every(u => !u.isError), `every receipt of undo is one undo_edit takes: ${JSON.stringify(undone(r).map(u => (u.isError ? u.value : "ok")))}`);
		let now = await snapshot();
		assert.equal(takeOf(now), null, "the take is gone again");
		assert.deepEqual(now.objects.map(o => [o.name, o.attach ?? null]), [["cup", null], ["crate", null]], "left: the draft's two stand-ins, the cup not attached");
		report.undoFirst = { receipts: first.undo.length, left: diff(s0, now).length };
		pass(`undo: the ${first.undo.length} receipts of a first install are each taken by undo_edit, newest first; the take is gone, the draft's stand-ins stay`);
		// installed again; in a later turn its receipts are no edits of that turn
		const second = await install({ end: "report", variant: 0 }, "lift the cup again");
		assert.deepEqual([second.installed, second.attached?.[0]?.bone], [true, "rightHand"]);
		const s1 = await snapshot();
		r = await turn("take that back", [["call", "undo_edit", { receiptId: second.undo[0] }]]);
		assert.ok(r[0].isError, `a receipt of an earlier message is refused: ${JSON.stringify(r[0].value).slice(0, 200)}`);
		report.undoLater = String(r[0].value).slice(0, 160);
		await equal(s1, "a refused undo changes nothing");
		pass(`undo: in a later message the receipt is refused (${String(r[0].value).split(":")[0]}), so the tool says "in this message"`);
		// a second install on top, taken back in its turn: the scene is the one before it, take and kept spec too
		writer.plan = { end: "report", variant: 1 };
		r = await turn("and the other hand higher", [["motion"], ["result"], ["result"], ["undo"]]);
		const third = answer(r);
		assert.ok(third.installed && undone(r).length === third.undo.length && undone(r).every(u => !u.isError), JSON.stringify(undone(r).map(u => u.isError && u.value)));
		await equal(s1, "after the receipts of the second install: the scene before it");
		assert.equal(takeOf(await snapshot()).name, takeOf(s1).name);
		report.undoSecond = { receipts: third.undo.length };
		pass(`undo: a second install on top (${third.undo.length} receipts; an unchanged attach and a clear of no waypoints are not among them) is taken back exactly: cast, objects, the attached cup, the take and its kept spec equal`);
	}

	// --- row 4: what is installed ------------------------------------------------------------------------------------------
	if (wants("cases")) {
		if (!takeOf(await snapshot())) await install({ end: "report", variant: 0 });
		const texts = {};
		for (const [end, text] of [["cut", /^The motion writer ended at stop reason length before its report, so its last compiled motion \(compile 1, 72 frames\) is not installed\./], ["no", /^The motion writer's report says not to install its last compiled motion \(compile 1, 72 frames\) \(Install: no\)\./]]) {
			const before = await snapshot();
			writer.plan = { end, variant: 2 };
			const r = await turn(`case ${end}`, [["motion"], ["result"], ["result"]]), kept = answer(r);
			assert.deepEqual([kept.installed, kept.undo], [false, undefined]);
			assert.match(kept.notInstalled, text);
			texts[end] = kept.notInstalled;
			await equal(before, `${end}: nothing installed`);
			// a later turn installs it on request and takes it back
			const next = await turn("install it anyway", [["result", { install: true }], ["undo"]]), put = answer(next);
			assert.ok(put.installed && put.undo.length > 0 && undone(next).every(u => !u.isError), JSON.stringify(next.map(x => x.isError && x.value)));
			await equal(before, `${end}: installed on request and taken back`);
		}
		const before = await snapshot();
		writer.plan = { end: "same" };
		const r = await turn("case same", [["motion"], ["result"], ["result"], ["result", { install: true }]]);
		assert.equal(answer(r)?.notInstalled, "The motion writer ended with the scene and spec the Studio plays already: nothing new was installed.", JSON.stringify(r).slice(0, 900));
		assert.ok(last(r, "motion_result").isError && String(last(r, "motion_result").value).startsWith("NO_OFFER"), "the playing motion is not offered");
		await equal(before, "same: nothing installed");
		report.cases = texts;
		pass("cases: a writer cut before its report and a report with Install: no install nothing, say why, and are installed by motion_result { install: true } in a later turn; the playing motion installs nothing and is not offered");
	}

	// --- row 5: the writer outlives a stopped turn -------------------------------------------------------------------------
	if (wants("outlive")) {
		if (!takeOf(await snapshot())) await install({ end: "report", variant: 0 });
		// 1. Stop while the writer writes: the panel says so, nothing is installed without a turn, the next turn collects
		let before = await snapshot(), runs = writer.runs;
		writer.plan = { end: "report", variant: 3, gate1: "w1" };
		const stopped = await startAndStop("he lifts it higher", "a1", { wind: false });
		assert.equal(writer.runs, runs + 1);
		const note = await stoppedNote();
		assert.ok(note.endsWith(NOTE[locale]), `the stopped turn's note: ${note}`);
		await panelShot(`outlive-1-stopped-${locale}`);
		report.stopNote = note;
		await waitFor(() => writer.steps > 0, "the writer compiled after the Stop");
		gate("w1").open();
		await sleep(2500);
		await equal(before, "the writer ended while the stopped run still wound down: nothing installed");
		await stopped.wind();
		await sleep(1000);
		await equal(before, "the writer ended while no turn runs: nothing installed");
		assert.equal(writer.closed, 0, "the Stop did not cut the writer");
		let r = await turn("and now?", [["result"], ["result"]]);
		assert.ok(agent.contexts.at(-1).includes("Studio motion observation: a motion that an earlier turn of this conversation started has ended and nothing of it is installed; motion_result answers it."), agent.contexts.at(-1).slice(-400));
		assert.equal(answer(r).installed, true);
		assert.notEqual(takeOf(await snapshot()).name, takeOf(before).name);
		pass(`outlive: Stop leaves the writer running (the panel: "${NOTE[locale].slice(0, 46)}..."); nothing is installed until the next turn's motion_result, which installs it`);
		assert.ok(!agent.contexts.at(-1).includes("USER'S WORDS") && (await turn("thanks", [])) && !agent.contexts.at(-1).includes("Studio motion observation: a motion"), "collected: the next turn is told nothing of it");

		// 2. two stops in a row, a new motion while the first is written, a stop on request before any compile
		before = await snapshot();
		writer.plan = { end: "report", variant: 4, gate0: "w2" };
		await startAndStop("he waves the cup", "a2");
		const told = agent.contexts.length;
		await turn("wait", [["gate", "a3"]], { wait: false });
		await waitFor(() => agent.contexts.length > told, "the second turn reached its model");
		await stop();
		gate("a3").open(); await sleep(400);
		assert.ok(agent.contexts.at(-1).includes("is still being written and nothing of it is installed; motion_result waits for it and answers it."));
		r = await turn("make him jump instead", [["motion"], ["result", { stop: true }]]);
		assert.ok(r[0].isError && String(r[0].value).startsWith("MOTION_RUNNING: A motion of this conversation is still being written"), String(r[0].value).slice(0, 200));
		assert.ok(r[1].isError && /The motion writer was stopped before it compiled a motion/.test(String(r[1].value)), String(r[1].value).slice(0, 200));
		await equal(before, "stopped before a compile: nothing installed");
		gate("w2").open();
		pass("outlive: after two stops in a row the motion is still told; a new motion call is refused while it is written; motion_result { stop: true } stops the writer");

		// 3. a stop on request after a compile keeps what it has, and install: true installs that; then it is taken back
		before = await snapshot();
		writer.plan = { end: "report", variant: 5, gate1: "w3" };
		const steps = writer.steps;
		setTimeout(async () => { for (let i = 0; i < 200 && writer.steps === steps; i++) await sleep(50); gate("a4").open(); }, 0);
		r = await turn("he lifts it to his chin", [["motion"], ["gate", "a4"], ["result", { stop: true }], ["result", { install: true }], ["undo"]]);
		const kept = r.filter(x => x.name === "motion_result")[0].value, put = r.filter(x => x.name === "motion_result")[1];
		assert.match(kept.notInstalled, /^The motion writer was stopped on request before its report, so its last compiled motion \(compile 1, 72 frames\) is not installed\./);
		assert.ok(!put.isError && put.value.installed === true, `the offered motion goes in after a stop: ${JSON.stringify(put.value).slice(0, 300)}`);
		assert.ok(undone(r).every(u => !u.isError));
		await equal(before, "stopped, installed on request, taken back");
		gate("w3").open();
		pass("outlive: a writer stopped on request after a compile answers what it has; motion_result { install: true } installs it");

		// 4. the writer ended while no turn ran; the user asks to stop it: it is kept out, not thrown away
		before = await snapshot();
		writer.plan = { end: "report", variant: 6, gate1: "w4" };
		const done = writer.steps;
		await startAndStop("he lowers the cup", "a5");
		await waitFor(() => writer.steps > done, "the writer compiled");
		gate("w4").open();
		await sleep(1500);
		r = await turn("stop that motion", [["result", { stop: true }]]);
		assert.match(answer(r).notInstalled, /^The motion was stopped on request before its install, so its last compiled motion \(compile 1, 72 frames\) is not installed\./);
		await equal(before, "stopped before its install: nothing installed");
		r = await turn("no, put it in", [["result", { install: true }]]);
		assert.equal(answer(r).installed, true);
		pass("outlive: a finished motion the user asks to stop before a turn took it in is kept out and still installed on request");

		// 5. a queued message sent after Stop is the next turn: it is told of the motion and collects it
		before = await snapshot();
		writer.plan = { end: "report", variant: 7, gate1: "w5" };
		const from = agent.results.length;
		await turn("he tilts the cup", [["motion"], ["gate", "a6"]], { wait: false });
		await waitFor(() => agent.results.slice(from).some(x => x.name === "motion"), "the motion started");
		await say("queued: is it done?");
		await waitFor("document.querySelectorAll('.agent-queue-row').length === 1", "the queued row");
		await stop();
		gate("a6").open(); await sleep(400);
		await equal(before, "stopped with a queued message: nothing installed");
		agent.epoch++; agent.program = [["result"], ["result"]];
		gate("w5").open();
		const at = agent.results.length;
		await click(".agent-queue-row .agent-queue-send");
		await waitFor(() => agent.results.slice(at).some(x => x.name === "motion_result" && x.value?.installed === true), "the queued turn collected the motion");
		await idle();
		assert.ok(agent.contexts.at(-1).includes("Studio motion observation: a motion that an earlier turn of this conversation started"));
		pass("outlive: a queued message sent after Stop starts the next turn, which is told of the motion and installs it");

		// 6. the user edits the message that started the motion: its writer is stopped, the corrected message starts its own
		writer.plan = { end: "report", variant: 8, gate1: "w6" };
		const closed = writer.closed, compiled = writer.steps;
		await startAndStop("he drops the cup", "a7");
		await waitFor(() => writer.steps > compiled, "the writer of the first wording compiled");
		await click(".agent-edit-open");
		await waitFor("!!document.querySelector('.agent-edit-input')", "the edit box");
		await evaluate("(() => { const box = document.querySelector('.agent-edit-input'); box.focus(); box.select(); })()");
		await send("Input.insertText", { text: "he puts the cup down gently" });
		writer.plan = { end: "report", variant: 9 };
		agent.epoch++; agent.program = [["result"], ["motion"], ["result"], ["result"]];
		const mark = agent.results.length;
		await t.press("Enter");
		await waitFor(() => agent.results.slice(mark).some(x => x.name === "motion_result" && x.value?.installed === true), "the corrected message's motion");
		await idle();
		r = agent.results.slice(mark);
		assert.ok(r[0].isError && String(r[0].value).startsWith("NO_MOTION"), `the cut turn's motion is gone: ${String(r[0].value).slice(0, 160)}`);
		assert.ok(writer.closed > closed, "its writer was stopped");
		assert.ok(agent.contexts.at(-1).includes("<edited-message>") && !agent.contexts.at(-1).includes("Studio motion observation: a motion"), "the corrected turn is told of the edit and of no motion");
		assert.ok(writer.requests.at(-1).includes("he puts the cup down gently") && !writer.requests.at(-1).includes("he drops the cup"));
		gate("w6").open();
		pass("outlive: an edit of the message that started a motion stops that writer; the corrected message's motion is written and installed");

		// 7. another scene is opened meanwhile: nothing goes into it; back in its scene the motion is installed on request
		const home = (await snapshot()).sceneId;
		writer.plan = { end: "report", variant: 10, gate1: "w7" };
		const n = writer.steps;
		await startAndStop("he raises the cup again", "a8");
		await waitFor(() => writer.steps > n, "the writer compiled");
		await act("scene.create", {});
		await waitFor(async () => (await snapshot()).sceneId !== home, "the new scene is open");
		const empty = await snapshot();
		gate("w7").open();
		await sleep(1500);
		r = await turn("is the motion in?", [["result"]]);
		assert.match(answer(r).notInstalled, /^Another scene is open than the one the motion was written in, so its last compiled motion \(compile 1, 72 frames\) is not installed\./);
		await equal(empty, "the other scene is untouched");
		await act("scene.switch", { sceneId: home });
		await waitFor(async () => (await snapshot()).sceneId === home, "back in the motion's scene");
		const back = await snapshot();
		r = await turn("now install it", [["result", { install: true }]]);
		assert.equal(answer(r).installed, true);
		assert.notEqual(takeOf(await snapshot()).name, takeOf(back).name);
		pass("outlive: with another scene open the motion is kept out of it and said so; back in its own scene motion_result { install: true } installs it");

		// 8. the writer's first compile comes after a later turn took the motion over: that turn's motion_result shows the
		// compile on its row, answers the draft (the stand-in of a prop the scene lacks), and the next one installs
		writer.plan = { end: "report", variant: 11, extra: "stool", gate0: "w8", gate1: "w8b" };
		await startAndStop("he looks at a stool beside him", "a9");
		const start = agent.results.length;
		await turn("how far is it?", [["result"], ["result"]], { wait: false });
		await waitFor("[...document.querySelectorAll('.agent-panel *')].some(node => /Motion result|모션 결과/i.test(node.textContent ?? ''))", "the motion_result row").catch(() => {});
		await sleep(600);
		gate("w8").open();
		await waitFor(() => agent.results.slice(start).some(x => x.name === "motion_result" && x.value?.draft === true), "the draft answered in the later turn");
		const draft = agent.results.slice(start).find(x => x.value?.draft === true).value;
		assert.equal(draft.standIns.length, 1, JSON.stringify(draft.standIns));
		assert.equal((await snapshot()).objects.filter(o => o.name === "stool").length, 1, "the draft's stand-in is in the scene, made in the turn that holds the motion");
		gate("w8b").open();
		await idle();
		assert.equal(answer(agent.results.slice(start)).installed, true);
		assert.equal((await snapshot()).objects.filter(o => o.name === "stool").length, 1, "the install took the stand-in as its prop");
		pass("outlive: a later turn that took the motion over gets its draft (the stand-in of a new prop) and then the install, one stool in the scene");
	}

	// --- row R: a place on the bone set by hand survives ---------------------------------------------------------------------
	if (wants("place")) {
		let now = await snapshot();
		if (!takeOf(now) || cupOf(now)?.attach?.bone !== "rightHand") { await install({ end: "report", variant: 0 }); now = await snapshot(); }
		const cup = cupOf(now).id, clipPlace = place(cupOf(now));
		// not edited: the next motion puts the clip's place again and the writer is told no numbers of it
		let done = await install({ end: "report", variant: 11 }, "the other hand a little higher");
		assert.equal(done.attached[0].kept, undefined);
		assert.ok(writer.requests.at(-1).includes(`cup (size [0.08,0.1,0.08]) on ${writer.requests.at(-1).match(/on (\S+)'s rightHand/)[1]}'s rightHand. A prop`) && !writer.requests.at(-1).includes("set by hand"), writer.requests.at(-1).split("\n\n").find(p => p.startsWith("These objects")));
		assert.deepEqual(place(cupOf(await snapshot())), clipPlace);
		// the user moves and turns the cup in the hand
		const edited = { x: clipPlace[0] + 0.02, y: clipPlace[1] - 0.03, z: clipPlace[2] + 0.01, rotX: clipPlace[3] + 10, rot: clipPlace[4], rotZ: clipPlace[5] + 15 };
		await act("object.attach", { objectId: cup, characterId: ID, bone: "rightHand", local: edited });
		const hand = place(cupOf(await snapshot()));
		assert.ok(Math.abs(hand[0] - edited.x) < 1e-6 && Math.abs(hand[1] - edited.y) < 1e-6, `the hand-set place is in the scene: ${hand}`);
		const before = await snapshot();
		writer.plan = { end: "report", variant: 12 };
		let r = await turn("the other hand lower", [["motion"], ["result"], ["result"], ["undo"]]);
		done = answer(r);
		assert.equal(done.attached[0].kept, true, "the next motion keeps the place set by hand");
		assert.match(writer.requests.at(-1), /rightHand at \[[-\d., ]+\] m, turned \[[-\d., ]+\] degrees in that bone's frame \(set by hand\)\. A prop of your scene/);
		assert.ok(writer.requests.at(-1).includes(" One set by hand keeps that place and turn while your clip keeps it on that bone: your clip's place for it is not drawn."));
		assert.ok(undone(r).every(u => !u.isError));
		await equal(before, "the install that kept the place, taken back: the scene before it, the hand-set place too");
		done = await install({ end: "report", variant: 12 }, "the other hand lower");
		assert.deepEqual([done.attached[0].kept, place(cupOf(await snapshot()))], [true, hand]);
		done = await install({ end: "report", variant: 13 }, "and a little lower still");
		assert.deepEqual([done.attached[0].kept, place(cupOf(await snapshot()))], [true, hand], "a follow-up edit of the motion keeps it too");
		pass("place: an unedited cup takes the clip's place; one set by hand keeps place and turn over an install, its undo and a follow-up; the writer is told \"(set by hand)\" only then");
		// a refit after a scale change keeps it, and its receipts take the refit back
		await act("character.update", { characterId: ID, patch: { scale: 0.8 } });
		const resized = await snapshot();
		r = await turn("fit the motion to his size", [["motion", {}], ["undo"]]);
		const refit = r[0].value;
		assert.ok(refit.refit?.length === 1 && refit.undo?.length > 0 && undone(r).every(u => !u.isError), JSON.stringify(r.map(x => (x.isError ? x.value : Object.keys(x.value)))).slice(0, 400));
		await equal(resized, "the refit, taken back by its receipts");
		r = await turn("fit the motion to his size", [["motion", {}]]);
		assert.equal(r[0].value.refit.length, 1);
		assert.deepEqual(place(cupOf(await snapshot())), hand, "a refit to another size keeps the place set by hand");
		pass("place: a refit after a scale change keeps the hand-set place; the refit's receipts take it back exactly");
		// saved and loaded again: the take still says what its install attached, so the hand-set place is still known as such
		const saved = await snapshot();
		await send("Page.reload", {});
		await waitFor("!!window.__cozyclay?.runStudioAction && !!document.querySelector('.studio-agent-bar')", "the Studio after a reload", 120_000);
		await sleep(1500);
		const loaded = await snapshot();
		assert.deepEqual([place(cupOf(loaded)), takeOf(loaded).lowvis.attached], [hand, takeOf(saved).lowvis.attached], "after a reload: the place and the take's list");
		if (!(await evaluate("!!document.querySelector('.agent-input') && document.querySelector('.agent-input').offsetParent !== null"))) await click(".studio-agent-bar");
		await waitFor("document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled", "agent composer ready");
		done = await install({ end: "report", variant: 14 }, "after the reload: the other hand up");
		assert.deepEqual([done.attached[0].kept, place(cupOf(await snapshot()))], [true, hand], "after a reload the place set by hand is kept");
		// a duplicate of the scene: the same there
		await act("scene.duplicate", { sceneId: loaded.sceneId });
		await waitFor(async () => (await snapshot()).sceneId !== loaded.sceneId, "the duplicate is open");
		const copy = await snapshot();
		assert.deepEqual([cupOf(copy).id, place(cupOf(copy))], [cup, hand]);
		done = await install({ end: "report", variant: 15 }, "in the copy: the other hand down");
		assert.deepEqual([done.attached[0].kept, place(cupOf(await snapshot()))], [true, hand], "in a duplicate the place set by hand is kept");
		pass("place: after a reload and in a duplicated scene the hand-set place is kept by the next install");
		// the clip carries it in the other hand: the place on the right hand no longer applies, the clip's is taken
		done = await install({ end: "report", variant: 16, hand: "L" }, "he takes it in the left hand");
		now = await snapshot();
		assert.deepEqual([done.attached[0].bone, done.attached[0].kept, cupOf(now).attach.bone], ["leftHand", undefined, "leftHand"]);
		assert.notDeepEqual(place(cupOf(now)), hand);
		report.place = { clip: clipPlace, hand, otherBone: place(cupOf(now)) };
		pass("place: a motion that carries it on another bone attaches it there at the clip's place (the answer has no kept)");
	}

	// --- row S: a size the user changes by hand: told at once, in the panel and as a toast ---------------------------------
	if (wants("size")) {
		let now = await snapshot();
		if (!takeOf(now)) { await install({ end: "report", variant: 0 }); now = await snapshot(); }
		if ((now.characters.find(c => c.id === ID).scale ?? 1) !== 1) { await act("character.update", { characterId: ID, patch: { scale: 1 } }); await turn("fit", [["motion", {}]]); }
		await act("view.select", { selection: { kind: "character", id: ID } });
		const hint = () => evaluate("document.querySelector('[data-fid=\"motion_size_note\"]')?.textContent ?? ''");
		assert.equal(await hint(), "", "a body of the motion's size: no note");
		// the Scale slider of the Character panel, with the pointer
		const head = await evaluate(`(() => { const head = [...document.querySelectorAll('.foldout-head')].find(h => h.offsetParent !== null && /^(Transform|변환)$/.test(h.querySelector('.foldout-title')?.textContent ?? '')); if (!head) return 'none'; head.dataset.qa = 'transform'; return head.getAttribute('aria-expanded'); })()`);
		assert.notEqual(head, "none", "the Transform foldout of the Character panel");
		if (head !== "true") await click("[data-qa=transform]");
		await sleep(700); // the foldout opens
		const range = await waitFor(`(() => { const s = [...document.querySelectorAll('.cslider')].find(c => c.offsetParent !== null && /^(Scale|크기)/.test(c.querySelector('.cslider-head span')?.textContent ?? '')); if (!s) return null; const i = s.querySelector('input[type=range]'); i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width, at: (Number(i.value) - Number(i.min)) / (Number(i.max) - Number(i.min)) }; })()`, "the Scale slider");
		// a drag of the thumb to the left, with the pointer: press on it, move, release
		const thumb = { x: range.x + 8 + (range.w - 16) * range.at, y: range.y };
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...thumb });
		await send("Input.dispatchMouseEvent", { type: "mousePressed", ...thumb, button: "left", clickCount: 1 });
		for (let k = 1; k <= 4; k++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: thumb.x - k * range.w * 0.03, y: thumb.y, button: "left", buttons: 1 });
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: thumb.x - range.w * 0.12, y: thumb.y, button: "left", clickCount: 1 });
		await waitFor(async () => (await hint()) !== "", "the size note in the panel");
		const text = await hint(), toast = await evaluate("document.querySelector('.toast')?.textContent ?? ''");
		assert.match(text, HINT[locale]);
		assert.equal(toast, TOAST[locale], "and said as a toast when the size changed");
		await shot(`size-1-slider-${locale}`);
		report.size = { hint: text, toast, scale: (await snapshot()).characters.find(c => c.id === ID).scale };
		// the agent's refit (no model) takes it away
		const r = await turn("fit the motion to this size", [["motion", {}]]);
		assert.equal(r[0].value.refit?.length, 1, JSON.stringify(r[0].value).slice(0, 300));
		await waitFor(async () => (await hint()) === "", "the note goes with the refit");
		// the scale knob of the character's gizmo (key R), pulled with the pointer: told the same way
		await sleep(2600); // the first toast is gone
		const key = (type, code, k) => send("Input.dispatchKeyEvent", { type, code, key: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
		await evaluate("document.activeElement?.blur()");
		await key("keyDown", "KeyR", "r"); await key("keyUp", "KeyR", "r");
		await sleep(800);
		const knobs = await evaluate(`(async () => {
			const { HANDLE_PROXY_FLAG } = await import("/src/gizmo-claim.js"), qa = window.__cozyclay;
			let root = qa.rigs[${JSON.stringify(ID)}]; while (root.parent) root = root.parent; root.updateMatrixWorld(true);
			const r = document.elementFromPoint(innerWidth * 0.45, innerHeight * 0.4).getBoundingClientRect(), out = [];
			root.traverse(n => { if (n.isMesh && n.userData?.[HANDLE_PROXY_FLAG]) { const at = n.getWorldPosition(new (n.position.constructor)()).project(qa.activeCam); out.push([r.x + (at.x + 1) / 2 * r.width, r.y + (1 - at.y) / 2 * r.height]); } });
			return out;
		})()`);
		assert.ok(knobs.length > 0, "the scale gizmo is shown");
		const scaleNow = () => evaluate(`window.__cozyclay.characters.find(c => c.id === ${JSON.stringify(ID)}).scale`), was = await scaleNow();
		for (const [x, y] of knobs) {
			await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
			await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
			for (let k = 1; k <= 3; k++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + k, y: y - k, button: "left" });
			await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 3, y: y - 3, button: "left", clickCount: 1 });
			await sleep(400);
			if (await scaleNow() !== was) break;
		}
		assert.notEqual(await scaleNow(), was, "the knob changed the scale");
		assert.ok((await hint()) !== "" && (await evaluate("document.querySelector('.toast')?.textContent ?? ''")) === TOAST[locale], `the knob's resize is told too: ${await hint()}`);
		await shot(`size-2-knob-${locale}`);
		report.size.knob = { from: was, to: await scaleNow(), hint: await hint() };
		await key("keyDown", "KeyW", "w"); await key("keyUp", "KeyW", "w");
		pass(`size: a size changed with the Scale slider or the gizmo's scale knob is told at once in the Character panel and as a toast (${locale}); the agent's refit takes the note away`);
	}
}
