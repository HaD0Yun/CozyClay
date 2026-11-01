// One capture of the stage with some scene bodies drawn see-through (verify_result's own views: what stands between the
// camera and the character, motion3/sightline.js). The stage is left as it was, also when the render throws.
const FADE_OPACITY = 0.18;

export function withFaded(scene, ids, render) {
	if (!ids?.length) return render();
	const wanted = new Set(ids), swapped = [];
	scene.traverse(group => {
		if (!wanted.has(group.userData?.sceneObjectId)) return;
		group.traverse(node => {
			if (!node.isMesh || !node.material) return;
			const was = node.material, see = m => { const c = m.clone(); c.transparent = true; c.opacity = FADE_OPACITY * m.opacity; c.depthWrite = false; return c; };
			node.material = Array.isArray(was) ? was.map(see) : see(was);
			swapped.push([node, was]);
		});
	});
	try { return render(); }
	finally {
		for (const [node, was] of swapped) {
			for (const m of [node.material].flat()) m.dispose();
			node.material = was;
		}
	}
}
