import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function verifyCastIdentity({ evaluate, transition, capture, record, send, events }) {
	const members = await evaluate("window.__cozyclay.characters.map(c=>c.id)");
	const row = id => `[data-node-id="character:${id}"]`;
	for (const id of members) {
		assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(row(id))})`), `stable row exists for ${id}`);
		await transition(`window.__cozyclay.activeChar.id===${JSON.stringify(id)}`, `document.querySelector(${JSON.stringify(row(id) + " .hierarchy-row")}).click()`);
		assert.equal(await evaluate("window.__cozyclay.sampleStateAt(0).activeCharacterId"), id);
	}
	record("identity-selection", { ids: members });
	await transition("!window.__cozyclay.lookThroughShot", "window.__cozyclay.setLookThrough(false)");
	await evaluate(`(()=>{window.__identityFramed=new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);resolve(true);};const timer=setTimeout(()=>{window.removeEventListener('cozyclay:editor-framed',done);reject(new Error('Editor framing deadline'));},30000);window.addEventListener('cozyclay:editor-framed',done,{once:true});});window.dispatchEvent(new KeyboardEvent('keydown',{code:'Home',key:'Home',bubbles:true}));return true;})()`);
	await evaluate("window.__identityFramed");
	await capture("identity-pick-layout");
	for (const id of members) {
		await transition(`document.querySelector('[data-node-id="environment"]').classList.contains('selected')`, `document.querySelector('[data-node-id="environment"] .hierarchy-row').click()`);
		const pixel = await evaluate(`(()=>{const q=window.__cozyclay,c=q.characters.find(c=>c.id===${JSON.stringify(id)}),p=q.rigs[c.id].parent,cam=q.editorCam,r=q.mainPane.getBoundingClientRect();p.updateWorldMatrix(true,false);cam.updateMatrixWorld();const v=p.getWorldPosition(cam.position.clone());v.y+=1.3*(c.scale??1);v.project(cam);return{x:r.x+(v.x+1)*r.width/2,y:r.y+(1-v.y)*r.height/2,inside:Math.abs(v.x)<1&&Math.abs(v.y)<1&&v.z<1};})()`);
		assert.equal(pixel.inside, true);
		await evaluate(`(()=>{window.__identityPicked=new Promise((resolve,reject)=>{const check=()=>{if(document.querySelector(${JSON.stringify(row(id))})?.classList.contains('selected')){cleanup();resolve(true);}},cleanup=()=>{observer.disconnect();window.removeEventListener('cast-qa:state',check);clearTimeout(timer);},observer=new MutationObserver(check),timer=setTimeout(()=>{cleanup();reject(new Error('Character pick deadline'));},30000);observer.observe(document,{subtree:true,attributes:true});window.addEventListener('cast-qa:state',check);check();});return true;})()`);
		await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pixel.x, y: pixel.y, button: "left", buttons: 1, clickCount: 1 });
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pixel.x, y: pixel.y, button: "left", buttons: 0, clickCount: 1 });
		await evaluate("window.__identityPicked");
		record("identity-viewport-pick", { id, pixel });
	}
	const eye = JSON.stringify(row(members[1]) + " .hierarchy-eye");
	await transition(`window.__cozyclay.characters[1].hidden`, `document.querySelector(${eye}).click()`);
	const hidden = await evaluate("window.__cozyclay.characters.map(c=>c.hidden)");
	assert.deepEqual(hidden, [false, true, false]);
	assert.equal(await evaluate("window.__cozyclay.activeChar.id"), members[2], "hiding a neighbor must not steal selection");
	await capture("identity-hidden");
	await transition(`window.__cozyclay.characters.every(c=>!!window.__cozyclay.rigs[c.id]?.parent)`, `document.querySelector(${eye}).click()`);
	for (let count = 4; count <= 5; count++) {
		const available = await evaluate(`(()=>{const button=document.querySelector('.add-subject'),r=button?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0;})()`);
		assert.ok(available, "a populated cast must still offer the visible add control");
		await transition(`window.__cozyclay.characters.length===${count}`, `document.querySelector('.add-subject').click()`);
	}
	await transition("window.__cozyclay.characters.every(c=>!!window.__cozyclay.rigs[c.id]?.parent)");
	const added = await evaluate("window.__cozyclay.characters.map(c=>c.id)");
	assert.equal(new Set(added).size, 5);
	assert.deepEqual(added.slice(0, 3), members);
	record("identity-add", { ids: added });
	await capture("identity-five");
	await evaluate(`import('/src/theme.js').then(theme=>theme.saveTheme('light'))`);
	await capture("identity-five-light");
	await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await capture("identity-five-light-mobile");
	await evaluate(`import('/src/theme.js').then(theme=>theme.saveTheme('dark'))`);
	await capture("identity-five-dark-mobile");
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

	const serialized = await readFile(new URL("./fixtures/cast-pair-v2.cclayproject", import.meta.url), "utf8");
	const dialogs = events.get("Page.javascriptDialogOpening") ?? new Set();
	events.set("Page.javascriptDialogOpening", dialogs);
	let accepted = Promise.resolve();
	const accept = () => { accepted = send("Page.handleJavaScriptDialog", { accept: true }); };
	dialogs.add(accept);
	try {
		const receipt = await evaluate(`window.__cozyclay.runStudioAction('project.open',{serialized:${JSON.stringify(serialized)}})`);
		await accepted;
		assert.equal(receipt?.ok, true, JSON.stringify(receipt));
	} finally { dialogs.delete(accept); }
	await transition(`window.__cozyclay.characters.length===2&&window.__cozyclay.characters[0].id==='char-a'&&window.__cozyclay.characters.every(c=>!!window.__cozyclay.rigs[c.id]?.parent)`);
	const legacy = await evaluate("window.__cozyclay.characters.map(c=>({id:c.id,x:c.x,z:c.z,pose:c.pose.id,frames:c.layer.waypoints.map(w=>w.frame)}))");
	assert.deepEqual(legacy, [
		{ id: "char-a", x: -2, z: 0, pose: "legacy-first-pose", frames: [12] },
		{ id: "char-b", x: 2, z: 0, pose: "legacy-second-pose", frames: [24] },
	]);
	for (const member of legacy) {
		await transition(`window.__cozyclay.activeChar.id===${JSON.stringify(member.id)}`, `document.querySelector(${JSON.stringify(row(member.id) + " .hierarchy-row")}).click()`);
	}
	record("identity-legacy-file", { characters: legacy });
	await capture("identity-legacy-file");
	await transition("window.__cozyclay.characters.length===0&&window.__cozyclay.activeChar.id===null&&!!document.querySelector('[data-inspector-empty]')", "window.__cozyclay.runStudioAction('cast.replace',{characters:[]})");
	const empty = await evaluate(`({ids:window.__cozyclay.characters.map(c=>c.id),active:window.__cozyclay.activeChar.id,rig:!!window.__cozyclay.rigA,rows:[...document.querySelectorAll('[data-node-id^="character:"]')].map(e=>e.dataset.nodeId)})`);
	assert.deepEqual(empty, { ids: [], active: null, rig: false, rows: [] });
	record("identity-empty", empty);
	await capture("identity-empty");
}
