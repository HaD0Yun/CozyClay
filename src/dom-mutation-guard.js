// Page translators rewrite the text nodes React rendered: Chrome and Edge
// translation wrap them in <font>, merge a run of them into one, or move them.
// The studio opts out with translate="no" (#972), but translation extensions
// and some browsers do not honour it. React then calls removeChild or
// insertBefore with a node that is no longer a child of that parent, the DOM
// throws NotFoundError, and the whole studio falls to the crash screen (#1046).
//
// Tolerate exactly that case and nothing else: when the node is still inside
// the parent (wrapped one level down), act on the child that holds it; when it
// is gone, skip the remove or append the insert. Every call with a real child
// goes to the native method unchanged.

/** The direct child of `parent` that contains `node`, or null when `node` left `parent`. */
function childHolding(parent, node) {
	for (let current = node; current; current = current.parentNode) {
		if (current.parentNode === parent) return current;
	}
	return null;
}

/** Patch removeChild and insertBefore on `proto` (Node.prototype by default) once. */
export function installDomMutationGuard(proto = globalThis.Node?.prototype) {
	if (!proto || proto.removeChild?.cozyclayGuard) return false;
	const nativeRemove = proto.removeChild;
	const nativeInsert = proto.insertBefore;
	function removeChild(child) {
		if (child?.parentNode === this) return nativeRemove.call(this, child);
		// Moved deeper (a translator's wrapper): remove it where it now lives.
		if (child?.parentNode && childHolding(this, child)) return nativeRemove.call(child.parentNode, child);
		// Replaced or removed by someone else: it is already out of the tree.
		return child;
	}
	function insertBefore(node, reference) {
		if (!reference || reference.parentNode === this) return nativeInsert.call(this, node, reference);
		// Keep the order React asked for: before the wrapper that holds the
		// reference, or at the end when the reference is gone.
		return nativeInsert.call(this, node, childHolding(this, reference));
	}
	removeChild.cozyclayGuard = true;
	insertBefore.cozyclayGuard = true;
	proto.removeChild = removeChild;
	proto.insertBefore = insertBefore;
	return true;
}
