// Issue #438: bus command discovery. A command registered only in the
// editor's registry is listed by, and callable through, the agent's
// run_action, MCP (studio_commands / studio_run) and the CLI (`cclay live
// commands` / `cclay live run`), with no agent, MCP or CLI code naming it.
//
// The editor is the actual App binding over its actual registry
// (app-fixture.mjs), connected to a real live hub over a real socket. The MCP
// handlers, the agent's tools and the CLI child process are the shipped ones.
// Run one case with COZYCLAY_DISCOVERY_CASE=<name> (the App fixture owns argv).
import assert from 'node:assert/strict';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchLiveFrame } from '../../src/live-control.js';
import { validateReceipt } from '../../src/studio-agent-protocol.js';
import { appFixture } from './app-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'cozyclay-discovery-'));
process.env.XDG_CONFIG_HOME = scratch;
process.env.COZYCLAY_AGENT_SESSIONS_DIR ??= join(scratch, 'sessions');
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const { startLiveHub } = await import('../../mcp/live-hub.mjs');
const { publishLiveEndpoint } = await import('../../bin/live-endpoint.mjs');
const mcp = await import('../../mcp/tool-handlers.mjs');

const TOKEN = randomBytes(32).toString('hex');
const launcher = fileURLToPath(new URL('../../bin/cozyclay.mjs', import.meta.url));

const within = (promise, label, milliseconds = 20_000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
};
const signal = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const identity = ({ workspaceId, documentEpoch, sceneId, sceneEpoch }) => ({ workspaceId, documentEpoch, sceneId, sceneEpoch });

/** The fixture command: registered in this editor's registry and nowhere else. */
const STAMP = Object.freeze({ id: 'fixture.stamp', label: 'Stamp the fixture', kind: 'job', timeoutMs: 120_000,
  description: 'A command registered only in this editor fixture; no agent, MCP or CLI code names it.',
  input: { type: 'object', properties: { note: { type: 'string', minLength: 1, maxLength: 40 } }, required: [], additionalProperties: false } });
const stamped = args => ({ affectedIds: [], summary: `Stamped ${args.note ?? 'nothing'}.`, output: { note: args.note ?? null } });

/** One editor on its own hub. `pending(name)` reads the deadline of every
 * frame of that command the hub is still waiting on. */
async function studio(commands = [{ ...STAMP, run: stamped }]) {
  const f = appFixture();
  for (const command of commands) f.registry.register({ available: () => true, ...command });
  const hub = await startLiveHub(0, { token: TOKEN, owner: 'mcp' });
  publishLiveEndpoint({ port: hub.port, token: TOKEN, owner: 'mcp' });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/live`);
  const welcomed = signal();
  socket.addEventListener('message', async event => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'workspace') return welcomed.resolve(frame.handle);
    const response = await dispatchLiveFrame(event.data, f.binding.handlers);
    if (response && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  });
  await within(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }), 'the editor socket');
  socket.send(JSON.stringify({ type: 'hello', role: 'editor', version: 1, workspaceId: f.binding.context().host.workspaceId }));
  const handle = await within(welcomed.promise, 'the workspace handle');
  // The context names the handle the agent route resolves on this hub.
  f.scope.liveWorkspaceHandleRef.current = handle;
  mcp.setLiveHub(hub);
  return { f, hub, handle,
    pending: name => [...hub.pending.values()].filter(entry => entry.name === name).map(entry => entry.timeoutMs),
    async close() {
      mcp.setLiveHub(null); socket.close();
      for (const peer of hub.server.clients) peer.terminate();
      await new Promise(resolve => hub.server.close(resolve));
      f.dispose();
    } };
}

/** An MCP tool call as the server makes it: each declared field through its
 * own schema, run in the resolved workspace. */
const tools = mcp.createToolHandlers({});
async function callTool(name, args, handle) {
  const tool = tools.find(entry => entry.name === name);
  assert.ok(tool, `MCP registers ${name}`);
  const parsed = Object.fromEntries(Object.entries(tool.inputSchema).map(([key, schema]) => [key, schema.parse(args[key])]));
  const result = await mcp.liveWorkspace.run(handle, () => tool.handler(parsed));
  const text = result.content[0].text;
  assert.doesNotMatch(text, /^Live editor error/, text);
  return { isError: result.isError === true, value: JSON.parse(text) };
}

/** `cclay live …` as an operator runs it, naming the fixture's workspace;
 * stdout is one JSON object. */
function cli(args, { hub, handle }) {
  const env = { ...process.env, XDG_CONFIG_HOME: scratch };
  delete env.COZYCLAY_LIVE_TOKEN;
  const child = spawn(process.execPath, [launcher, 'live', ...args, '--workspace', handle, '--live-port', String(hub.port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return within(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* the assertion below prints what came back */ }
      resolve({ code, stdout, stderr, json });
    });
  }), `cclay live ${args.join(' ')}`);
}

/** The agent's own tools for one turn, admitted at the editor's context. */
async function agentTools(s) {
  const { createStudioTools } = await import('../../bin/agent/studio-tools.mjs');
  const context = s.f.binding.context();
  const admission = { commandId: () => crypto.randomUUID(), host: identity(context.host), revision: context.revision.scene,
    async refresh() { admission.revision = s.f.binding.context().revision.scene; } };
  return createStudioTools({ liveHub: s.hub, workspaceHandle: s.handle,
    session: { admission, generation: { used: false, failures: 0 }, actionIndex: context.actionIndex } }).internal.invoke;
}

const cases = {};

cases['mcp-run'] = async () => {
  const s = await studio();
  try {
    const before = s.f.binding.context();
    const { isError, value: receipt } = await callTool('studio_run', { action: STAMP.id, args: { note: 'mcp' } }, s.handle);
    assert.equal(isError, false, JSON.stringify(receipt));
    validateReceipt(receipt);
    assert.deepEqual({ action: receipt.action, status: receipt.status, output: receipt.output }, { action: STAMP.id, status: 'completed', output: { note: 'mcp' } });
    assert.deepEqual(receipt.host, identity(before.host), 'admitted in the open document');
    // Admission is the editor's: a stale revision is refused before anything runs.
    const stale = await callTool('studio_run', { action: STAMP.id, args: {}, expectedRevision: before.revision.scene + 7 }, s.handle);
    assert.equal(stale.isError, true);
    assert.equal(stale.value.code, 'STALE_SCENE', JSON.stringify(stale.value));
    // A caller's commandId makes a retry answer the journalled receipt.
    const commandId = crypto.randomUUID();
    const first = await callTool('studio_run', { action: STAMP.id, args: { note: 'once' }, commandId }, s.handle);
    const retried = await callTool('studio_run', { action: STAMP.id, args: { note: 'once' }, commandId }, s.handle);
    assert.equal(first.value.commandId, commandId);
    assert.equal(retried.value.receiptId, first.value.receiptId, 'the retry is the same receipt');
  } finally { await s.close(); }
  console.log('PASS #438 acceptance 1: a command registered only in the editor runs through MCP studio_run and answers its bus receipt');
};

cases['cli-run'] = async () => {
  const s = await studio();
  try {
    const before = s.f.binding.context();
    const run = await cli(['run', STAMP.id, '--args', JSON.stringify({ note: 'cli' })], s);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const receipt = run.json;
    validateReceipt(receipt);
    assert.deepEqual({ action: receipt.action, status: receipt.status, output: receipt.output }, { action: STAMP.id, status: 'completed', output: { note: 'cli' } });
    assert.deepEqual(receipt.host, identity(before.host), 'admitted in the open document');
    // Arguments are the command's own schema, checked by the editor: a
    // refusal is its receipt, with its code and exit status 1.
    const refused = await cli(['run', STAMP.id, '--args', JSON.stringify({ note: '' })], s);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.equal(refused.json?.error?.code, 'INVALID_ARGUMENT', refused.stdout);
    assert.equal(refused.json.error.details.receipt.ok, false);
    // Without --args the command runs with none.
    const bare = await cli(['run', STAMP.id], s);
    assert.equal(bare.code, 0, bare.stdout + bare.stderr);
    assert.deepEqual(bare.json.output, { note: null });
  } finally { await s.close(); }
  console.log('PASS #438 acceptance 2: a command registered only in the editor runs through `cclay live run` and prints its bus receipt');
};

cases['commands'] = async () => {
  const s = await studio();
  try {
    const registered = s.f.registry.list().filter(row => !row.agentHidden).map(row => row.id); // agentHidden ones (object.update, motion.v4.install) stay out of the index
    // The index: every registered command by id and label, no schemas.
    const index = await callTool('studio_commands', {}, s.handle);
    assert.equal(index.isError, false);
    assert.deepEqual(index.value.actions.map(row => row.id), registered, 'every command the editor registers, in its order');
    const row = index.value.actions.find(entry => entry.id === STAMP.id);
    assert.deepEqual({ id: row.id, label: row.label, available: row.available }, { id: STAMP.id, label: STAMP.label, available: true });
    assert.ok(index.value.actions.every(entry => !('input' in entry) && !('description' in entry)), 'the index carries no schema or description');
    // Schemas on request: the named commands' full declarations.
    const schema = await callTool('studio_commands', { ids: [STAMP.id] }, s.handle);
    assert.deepEqual(schema.value.actions.map(entry => entry.id), [STAMP.id]);
    assert.deepEqual(schema.value.actions[0].input, STAMP.input);
    assert.equal(schema.value.actions[0].description, STAMP.description);
    // The CLI reads the same index and the same schemas.
    const listed = await cli(['commands'], s);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.deepEqual(listed.json.actions, index.value.actions);
    const described = await cli(['commands', '--ids', STAMP.id], s);
    assert.equal(described.code, 0, described.stdout + described.stderr);
    assert.deepEqual(described.json.actions, schema.value.actions);
  } finally { await s.close(); }
  console.log('PASS #438 acceptance 3: studio_commands and `cclay live commands` list the editor-only command with its label; ids fetch its schema');
};

cases['context'] = async () => {
  const { buildStudioContext, encodeStudioContext } = await import('../../src/studio-agent-context.js');
  const { STUDIO_CONTEXT_MAX_BYTES, utf8ByteLength } = await import('../../src/studio-agent-protocol.js');
  const f = appFixture();
  try {
    f.registry.register({ ...STAMP, available: () => true, run: stamped });
    // The agent's turn context: an id/label row for every registered command.
    const context = f.binding.context();
    assert.ok(Array.isArray(context.actionIndex), 'the turn context carries the command index');
    assert.deepEqual(context.actionIndex.map(row => row.id), f.registry.list().filter(row => !row.agentHidden).map(row => row.id));
    const row = context.actionIndex.find(entry => entry.id === STAMP.id);
    assert.deepEqual({ id: row.id, label: row.label }, { id: STAMP.id, label: STAMP.label });
    const allowed = new Set(['id', 'label', 'generation', 'timeoutMs']);
    assert.ok(context.actionIndex.every(row => Object.keys(row).every(key => allowed.has(key))), 'index rows carry no schema, description or availability');
    const encoded = encodeStudioContext(context);
    assert.ok(!encoded.includes(STAMP.description), 'no description is inlined');
    assert.ok(!encoded.includes('"additionalProperties"'), 'no input schema is inlined');
    // The budget still holds with a crowded scene: the index is kept whole
    // while entity detail is compacted to fit.
    const { actionIndex, entityIndex, ...input } = structuredClone(context);
    const crowd = Array.from({ length: 400 }, (_, n) => ({ id: `prop-${String(n).padStart(3, '0')}`, kind: 'object', token: `token-${n}`,
      name: `A long descriptive name for set piece number ${n} `.repeat(3).slice(0, 120), position: { x: n / 10, y: 0, z: -n / 10 } }));
    const crowded = buildStudioContext({ ...input, entities: [...input.entities, ...crowd], actions: f.registry.list() });
    assert.ok(utf8ByteLength(encodeStudioContext(crowded)) <= STUDIO_CONTEXT_MAX_BYTES, 'the crowded context fits the budget');
    assert.deepEqual(crowded.actionIndex, context.actionIndex, 'the command index survives the budget');
    assert.ok(crowded.entityPage.truncated, 'entity detail made room, not the index');
  } finally { f.dispose(); }
  console.log('PASS #438 acceptance 4: the agent turn context holds the id/label command index and no schema, within the context budget');
};

cases['timeout'] = async () => {
  let entered, release;
  // The command holds until the test has read the hub's frame for it.
  const held = { ...STAMP, run: async args => { entered.resolve(); await release.promise; return stamped(args); } };
  const s = await studio([held]);
  const observe = async (label, start) => {
    entered = signal(); release = signal();
    const running = start();
    await within(entered.promise, `${label} reaching the editor`);
    const deadlines = s.pending('run_action');
    release.resolve();
    return { deadlines, outcome: await within(running, label) };
  };
  try {
    const invoke = await agentTools(s);
    const viaAgent = await observe('agent run_action', () => invoke('run_action', { action: STAMP.id, args: { note: 'agent' } }));
    assert.deepEqual(viaAgent.deadlines, [STAMP.timeoutMs], 'the agent frame waits the declared timeout, not the 30 s default');
    assert.equal(viaAgent.outcome.status, 'completed');
    const viaMcp = await observe('MCP studio_run', () => callTool('studio_run', { action: STAMP.id, args: { note: 'mcp' } }, s.handle));
    assert.deepEqual(viaMcp.deadlines, [STAMP.timeoutMs], 'the MCP frame waits the declared timeout');
    assert.equal(viaMcp.outcome.value.status, 'completed');
    const viaCli = await observe('cclay live run', () => cli(['run', STAMP.id], s));
    assert.deepEqual(viaCli.deadlines, [STAMP.timeoutMs], 'the CLI frame waits the declared timeout');
    assert.equal(viaCli.outcome.code, 0, viaCli.outcome.stdout);
    // A caller's own timeout comes from its frame and is capped at the ceiling.
    const capped = await observe('cclay live run --timeout', () => cli(['run', STAMP.id, '--timeout', '900000'], s));
    assert.deepEqual(capped.deadlines, [300_000], 'the hub caps a frame timeout at 300 s');
  } finally { await s.close(); }
  console.log('PASS #438 acceptance 5: a declared timeoutMs of 120 s reaches the hub frame from the agent, MCP and the CLI');
};

cases['confirm'] = async () => {
  const s = await studio();
  try {
    // A second scene through the UI's own door, so deleting one is available.
    await s.f.binding.bus.run('scene.create', {}, { origin: 'ui' });
    const scenes = () => s.f.scope.scenesRef.current.map(scene => scene.id);
    const sceneId = scenes().find(id => id !== s.f.scope.activeSceneIdRef.current);
    assert.equal(scenes().length, 2);
    const refusal = receipt => ({ ok: receipt.ok, code: receipt.code, phase: receipt.phase, mutated: receipt.mutated, message: receipt.message, recovery: receipt.recovery });
    const viaMcp = await callTool('studio_run', { action: 'scene.delete', args: { sceneId } }, s.handle);
    assert.equal(viaMcp.isError, true);
    validateReceipt(viaMcp.value);
    assert.equal(viaMcp.value.code, 'CONFIRMATION_REQUIRED', JSON.stringify(viaMcp.value));
    const viaCli = await cli(['run', 'scene.delete', '--args', JSON.stringify({ sceneId })], s);
    assert.equal(viaCli.code, 1, viaCli.stdout + viaCli.stderr);
    assert.equal(viaCli.json?.error?.code, 'CONFIRMATION_REQUIRED', viaCli.stdout);
    const invoke = await agentTools(s);
    const viaAgent = await invoke('run_action', { action: 'scene.delete', args: { sceneId } }).catch(error => error);
    assert.equal(viaAgent.code, 'CONFIRMATION_REQUIRED', viaAgent.message);
    // The same refusal, word for word, on every surface; nothing was deleted.
    assert.deepEqual(refusal(viaMcp.value), refusal(viaAgent.receipt));
    assert.deepEqual(refusal(viaCli.json.error.details.receipt), refusal(viaAgent.receipt));
    assert.deepEqual(scenes().length, 2, 'no surface deleted the scene');
  } finally { await s.close(); }
  console.log('PASS #438 acceptance 6: scene.delete without a confirmation token answers CONFIRMATION_REQUIRED through MCP and the CLI exactly as through the agent');
};

// The milestone: one command registered only in the editor, listed and called
// through the agent's real turn route, MCP and the CLI.
cases['milestone'] = async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createAgentHandler } = await import('../../bin/agent/agent-routes.mjs');
  const { createFakeModel } = await import('../fixtures/fake-model.mjs');
  let entered = null, release = null;
  const s = await studio([{ ...STAMP, run: async args => { entered?.resolve(); if (release) await release.promise; return stamped(args); } }]);
  const faux = createFakeModel();
  faux.script([
    { type: 'toolCall', id: 'schema-1', name: 'inspect_studio', arguments: { scope: 'actions', ids: [STAMP.id] } },
    { type: 'toolCall', id: 'run-1', name: 'run_action', arguments: { action: STAMP.id, args: { note: 'agent' } } },
    [{ type: 'text', text: 'Stamped.' }],
  ]);
  let server;
  const handler = createAgentHandler({ auth: { getAccessToken: async () => 'token' }, models: faux.models, fauxProvider: faux.fauxProvider, liveHub: s.hub, port: () => server.address().port });
  server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // Agent: the turn context names the command, the model reads its schema
    // on request and runs it; the frame waits the declared 120 s.
    entered = signal(); release = signal();
    const turn = { surface: 'studio', sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), text: 'Stamp the fixture.', context: s.f.binding.context() };
    const posted = fetch(`${origin}/agent/turn`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(turn), signal: AbortSignal.timeout(20_000) })
      .then(async response => ({ status: response.status, text: await response.text() }));
    await within(Promise.race([entered.promise, posted.then(ended => { throw new Error(`The turn ended before the command ran: ${ended.text}`); })]), 'the agent turn running the command');
    assert.deepEqual(s.pending('run_action'), [STAMP.timeoutMs], 'the agent route runs it under its declared timeout');
    release.resolve();
    const answered = await within(posted, 'the agent turn');
    assert.equal(answered.status, 200, answered.text);
    const done = [...answered.text.matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1])).filter(frame => frame.type === 'tool.done');
    assert.deepEqual(done.map(frame => [frame.callId, frame.ok]), [['schema-1', true], ['run-1', true]], answered.text);
    assert.deepEqual(done[0].result.actions.map(row => row.input), [STAMP.input], 'the schema arrives on request');
    assert.deepEqual({ action: done[1].result.action, status: done[1].result.status, output: done[1].result.output }, { action: STAMP.id, status: 'completed', output: { note: 'agent' } });
    const seen = faux.calls[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).map(part => part.text ?? '').join('\n');
    const actions = JSON.parse(/\n<actions>\n(.*)\n<\/actions>$/s.exec(getCurrentSystemPrompt(faux.calls[0].messages))[1]);
    assert.deepEqual(actions.find(row => row.id === STAMP.id), { id: STAMP.id, label: STAMP.label, timeoutMs: STAMP.timeoutMs }, 'the model sees the command in its index');
    assert.ok(!seen.includes(STAMP.description), 'and not its description or schema');
    // MCP and the CLI: the same command, listed and run.
    const listed = await callTool('studio_commands', {}, s.handle);
    assert.deepEqual(listed.value.actions.filter(row => row.id === STAMP.id).map(row => row.label), [STAMP.label]);
    const viaMcp = await callTool('studio_run', { action: STAMP.id, args: { note: 'mcp' } }, s.handle);
    assert.deepEqual(viaMcp.value.output, { note: 'mcp' });
    const commands = await cli(['commands'], s);
    assert.deepEqual(commands.json.actions.filter(row => row.id === STAMP.id).map(row => row.label), [STAMP.label]);
    const viaCli = await cli(['run', STAMP.id, '--args', JSON.stringify({ note: 'cli' })], s);
    assert.deepEqual(viaCli.json?.output, { note: 'cli' }, viaCli.stdout);
  } finally {
    await handler.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
  console.log('PASS #438 milestone: a command registered only in the editor is listed by and runs through the agent route, MCP and the CLI');
};

const selected = process.env.COZYCLAY_DISCOVERY_CASE || null;
if (selected && !cases[selected]) { console.error(`unknown case ${selected}; known: ${Object.keys(cases).join(', ')}`); process.exit(2); }
for (const [name, run] of Object.entries(cases)) if (!selected || selected === name) await run();
