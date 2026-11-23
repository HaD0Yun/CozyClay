// The inputs both the size test (verify-receipt-sizes.mjs) and a base-against-new comparison run: every
// primitive kind, sculpts of one and several parts, an empty with children, children of a turned and of a
// scaled parent, objects turned about each axis, per-axis and one-number scale, clamped scale, more objects
// than the readback limit, patches of scale / position / colour, a refused call and undo, all inside an
// agent turn as the Studio agent runs them. Each case answers the receipt (or refusal) and the scene rows.
import { objectsFixture } from './objects-fixture.mjs';

const sculpt = parts => ({ version: 1, parts });
const part = (id, size, position, extra = {}) => ({ id, shape: 'box', size, position, color: '#888888', ...extra });

export async function runSizeCases() {
	const f = objectsFixture([]), cases = [];
	const turnId = 'turn-sizes';
	const inTurn = (name, args) => ({ ...f.request(name, args), turnId });
	const call = async (label, name, args) => {
		const receipt = await (name === 'run_action' ? f.binding.handlers.run_action(inTurn('run_action', args)) : f.binding.handlers[name](inTurn(name, args)));
		f.binding.refresh();
		cases.push({ label, name, args, receipt: JSON.parse(JSON.stringify(receipt)), rows: JSON.parse(JSON.stringify(f.objects.read())) });
		return receipt;
	};
	const create = (kind, name, world, extra = {}) => ({ op: 'create', source: { kind }, name, position: { world }, ...extra });
	try {
		f.run('agent.turn.begin', { turnId }, 'agent', { turnId });
		await call('every primitive kind', 'arrange_objects', { ops: ['cube', 'sphere', 'capsule', 'cylinder', 'cone', 'plane'].map((kind, i) => create(kind, `P ${kind}`, { x: i * 3, y: 0, z: 0 })) });
		await call('one-number scale and per-axis scale', 'arrange_objects', { ops: [create('plane', 'Ground', { x: 0, y: 0, z: 20 }, { scale: { x: 33, y: 33, z: 33 } }), create('cube', 'Slab', { x: 8, y: 0, z: 20 }, { scale: { x: 4, y: 0.2, z: 2 } })] });
		await call('clamped scale on create', 'arrange_objects', { ops: [create('cube', 'Thin', { x: -8, y: 0, z: 20 }, { scale: { x: 1, y: 0.001, z: 1 } })] });
		await call('turned about each axis', 'arrange_objects', { ops: [['x', 30], ['y', 45], ['z', 60]].map(([axis, deg], i) => create('cube', `Turn ${axis}`, { x: i * 3, y: 1, z: -10 }, { rotationDeg: { x: 0, y: 0, z: 0, [axis]: deg } })) });
		await call('sixteen objects in one call', 'arrange_objects', { ops: Array.from({ length: 16 }, (_, i) => create(i % 2 ? 'cylinder' : 'cube', `Row ${i}`, { x: -30 + i * 2, y: 0, z: 30 }, { scale: { x: 1 + i / 10, y: 1, z: 1 + i / 10 } })) });
		await call('sculpt of one part', 'run_action', { action: 'object.sculpt', args: { name: 'Block', recipe: sculpt([part('a', [0.5, 0.8, 0.3], [0, 0.4, 0])]), placement: { x: 12, z: 12 } } });
		await call('sculpt of several parts', 'run_action', { action: 'object.sculpt', args: { name: 'Bench', recipe: sculpt([part('seat', [1.6, 0.08, 0.4], [0, 0.45, 0]), part('leg', [0.06, 0.45, 0.35], [0.7, 0.225, 0], { mirror: true })]), placement: { x: 15, z: 12 } } });
		const empty = await call('empty', 'run_action', { action: 'object.add', args: { kind: 'empty', name: 'Rig', placement: { x: -12, z: -12 } } });
		const rig = empty.affectedIds[0];
		await call('children of an empty', 'arrange_objects', { ops: [create('cube', 'Kid A', { x: 0.5, y: 0, z: 0 }, { parent: rig, space: 'parent' }), create('sphere', 'Kid B', { x: -0.5, y: 0, z: 0 }, { parent: rig, space: 'parent' })] });
		const turned = await call('turned parent', 'arrange_objects', { ops: [create('cube', 'Turned parent', { x: 20, y: 0, z: -20 }, { rotationDeg: { x: 0, y: 30, z: 0 } })] });
		await call('child of the turned parent', 'arrange_objects', { ops: [create('cube', 'Turned child', { x: 1, y: 0, z: 0 }, { parent: turned.affectedIds[0], space: 'parent', scale: { x: 2, y: 1, z: 0.5 } })] });
		const scaled = await call('scaled parent', 'arrange_objects', { ops: [create('cube', 'Scaled parent', { x: 25, y: 0, z: -20 }, { scale: { x: 3, y: 3, z: 3 } })] });
		await call('child of the scaled parent', 'arrange_objects', { ops: [create('cube', 'Scaled child', { x: 1, y: 0, z: 0 }, { parent: scaled.affectedIds[0], space: 'parent' })] });
		const ground = cases[1].receipt.affectedIds[0], slab = cases[1].receipt.affectedIds[1];
		await call('patch of scale', 'patch_elements', { ops: [{ target: { kind: 'object', id: ground }, set: { scale: { x: 16, y: 1, z: 12 } } }] });
		await call('patch of scale past the limit', 'patch_elements', { ops: [{ target: { kind: 'object', id: slab }, set: { scale: { x: 4, y: 0.001, z: 2 } } }] });
		await call('patch of position only', 'patch_elements', { ops: [{ target: { kind: 'object', id: slab }, set: { position: { x: 9, y: 0, z: 21 } } }] });
		await call('patch of one-number scale', 'patch_elements', { ops: [{ target: { kind: 'object', id: ground }, set: { scale: 20 } }] });
		await call('patch of colour only', 'patch_elements', { ops: [{ target: { kind: 'object', id: slab }, set: { color: '#aa3322' } }] });
		await call('arrange that only moves', 'arrange_objects', { ops: [{ op: 'update', id: slab, position: { world: { x: 10, y: 0, z: 22 } } }] });
		await call('scale through arrange update', 'arrange_objects', { ops: [{ op: 'update', id: slab, scale: { x: 2, y: 2, z: 2 } }] });
		await call('refused call', 'arrange_objects', { ops: [create('no-such-kind', 'Nope', { x: 0, y: 0, z: 0 })] }).catch(error => cases.push({ label: 'refused call', thrown: String(error?.message ?? error) }));
		await call('undo the last edit', 'undo_edit', { receiptId: cases.findLast(c => c.receipt?.receiptId).receipt.receiptId }).catch(error => cases.push({ label: 'undo the last edit', thrown: String(error?.message ?? error) }));
		await call('a hundred objects in one call', 'arrange_objects', { ops: Array.from({ length: 100 }, (_, i) => create('cube', `Mass ${i} ${'n'.repeat(40)}`, { x: -60 + (i % 10) * 2, y: 0, z: -60 + Math.floor(i / 10) * 2 }, { scale: { x: 1, y: 0.001, z: 1 } })) });
		f.run('agent.turn.finish', { turnId }, 'agent', { turnId });
	} finally { f.dispose(); }
	return cases;
}
