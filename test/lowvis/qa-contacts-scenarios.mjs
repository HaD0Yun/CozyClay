// A probe of test/lowvis/qa-install-browser.mjs (QA_PROBE=contacts): in a real Studio turn with the scripted
// agent and writer, the agent receives where the body meets the draft's stand-in (contacts), a look edit of it answers
// motionFit with the gaps the Studio measures on what it draws, and the install answers contacts and gaps.
//   QA_PROBE=contacts node test/lowvis/qa-install-browser.mjs
export async function scenarios(t) {
	const { turn, writer, agent, gate, pass, report, assert, waitFor, sleep } = t;
	// the writer's cup is held in the right hand from frame 0; the writer waits after its first compile until w1 opens
	writer.plan = { end: "report", variant: 0, gate1: "contacts-w1" };
	const from = agent.results.length;
	const running = turn("lift the cup", [["motion"], ["result"], ["gate", "contacts-a1"], ["result"]], { wait: false });
	const draft = await waitFor(() => agent.results.slice(from).find(r => r.name === "motion_result" && r.value?.draft === true)?.value, "the draft", 120_000);
	const line = (draft.contacts ?? []).find(l => l.startsWith("cup ("));
	assert.ok(line, `the draft names the cup's contacts: ${JSON.stringify(draft.contacts)}`);
	assert.match(line, /^cup \((\S+)\), where bodies meet it: \S+ right hand at \[[^\]]+\] f0-71/);
	const cup = /^cup \((\S+)\)/.exec(line)[1];
	pass(`draft: ${line}`);
	// the agent gives the cup a look 0.3 m off to the side of its box: the edit answers how far the hand is from it
	agent.program.unshift(["call", "run_action", { action: "object.sculpt", args: { id: cup, recipe: { version: 1, parts: [{ id: "body", shape: "box", size: [0.08, 0.1, 0.08], position: [0.3, 0.05, 0], roundness: 0 }] } } }]);
	gate("contacts-a1").open();
	const edit = await waitFor(() => agent.results.slice(from).find(r => r.name === "run_action")?.value, "the look edit", 60_000);
	const fit = edit.motionFit?.objects?.find(o => o.id === cup);
	assert.match(fit?.gaps ?? "", new RegExp(`^cup \\(${cup}\\), off the drawn look: \\S+ right hand at \\[[^\\]]+\\] f0-71: \\d+ mm from the drawn look$`), `the edit's gaps: ${JSON.stringify(edit.motionFit)}`);
	pass(`look edit: ${fit.gaps}`);
	gate("contacts-w1").open();
	await running;
	const done = await waitFor(() => agent.results.slice(from).filter(r => r.name === "motion_result" && r.value?.draft !== true).at(-1)?.value, "the installed result", 120_000);
	assert.equal(done.installed, true);
	assert.ok((done.contacts ?? []).some(l => l.startsWith(`cup (${cup}), where bodies meet it:`)), `install contacts: ${JSON.stringify(done.contacts)}`);
	assert.ok((done.gaps ?? []).some(l => l.startsWith(`cup (${cup}), off the drawn look:`)), `install gaps: ${JSON.stringify(done.gaps)}`);
	pass(`install: ${done.gaps.join(" | ")}`);
	await sleep(300);
	report.contacts = { draft: draft.contacts, edit: fit.gaps, install: { contacts: done.contacts, gaps: done.gaps } };
}
