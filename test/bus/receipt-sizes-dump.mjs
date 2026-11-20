// Prints, as one JSON document, everything the model would read from the size cases (receipt-sizes-cases.mjs):
// each answer (ids made stable), the same answers as a script's calls summary (one inner call per script, and
// all of them in one script), and every Studio tool description. Run it on two commits and compare the output
// to see exactly what a change altered: node test/bus/receipt-sizes-dump.mjs > out.json
import { runSizeCases } from './receipt-sizes-cases.mjs';
import { createScriptTool } from '../../bin/agent/script-tool.mjs';
import { createStudioTools } from '../../bin/agent/studio-tools.mjs';

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const stable = value => { const seen = new Map(); return JSON.parse(JSON.stringify(value).replace(uuid, id => { if (!seen.has(id)) seen.set(id, `uuid-${seen.size + 1}`); return seen.get(id); })); };
const cases = await runSizeCases();
const answer = c => c.thrown !== undefined ? { thrown: c.thrown } : c.receipt;
const scriptOf = async list => {
	let index = 0;
	const tool = { name: 'call', description: 'call', handler: async () => { const c = list[index++]; if (c.thrown !== undefined || c.receipt?.ok === false) throw Object.assign(new Error(c.thrown ?? c.receipt.message), { code: c.receipt?.code, receipt: c.receipt }); return c.receipt; } };
	const result = await createScriptTool({ tools: [tool] }).handler({ code: `for (let i = 0; i < ${list.length}; i++) { try { await tools.call({}); } catch (e) {} } return 0;` }, {});
	return result.calls;
};
const out = {
	answers: cases.map(c => ({ label: c.label, answer: answer(c) })),
	scriptOne: [], scriptAll: await scriptOf(cases),
	descriptions: Object.fromEntries([...createStudioTools({ liveHub: { command: async () => ({}) }, workspaceHandle: 'w' }), createScriptTool({ tools: [{ name: 'arrange_objects' }] })].map(tool => [tool.name, tool.description])),
};
for (const c of cases) out.scriptOne.push({ label: c.label, calls: await scriptOf([c]) });
// exit only once the pipe has the whole text (the fixture leaves handles open)
process.stdout.write(JSON.stringify(stable(out)), () => process.exit(0));
