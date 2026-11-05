// Restores a parsed project's embedded assets (images, meshes, HDRs) into the
// browser asset store. Shared by the Studio's open flow and the headless
// launcher (tools/headless-chrome.mjs), so both apply the same closure and
// content-address checks before a record lands in IndexedDB.
import { verifyEmbeddedAsset } from "./project.js";
import { openAssetDb, putAsset, referencedAssetIds } from "./scene-assets.js";

/** Returns the ids written; skips and warns about anything it refuses. */
export async function restoreProjectAssets(project, { open = openAssetDb, put = putAsset } = {}) {
	const restored = [];
	if (!project?.assets?.length) return restored;
	try {
		const db = await open();
		try {
			const referenced = referencedAssetIds(project.scenesDocument.scenes);
			const results = await Promise.allSettled(project.assets.map(async (asset) => {
				if (!referenced.has(asset.id)) {
					console.warn(`[cozyclay] skipped embedded asset outside the project closure: ${asset.id}`);
					return;
				}
				if (!(await verifyEmbeddedAsset(asset))) {
					console.warn(`[cozyclay] skipped embedded asset with mismatched content address: ${asset.id}`);
					return;
				}
				await put(db, asset);
				restored.push(asset.id);
			}));
			for (const result of results) if (result.status === "rejected") console.warn("[cozyclay] could not restore an embedded asset", result.reason);
		} finally {
			db.close?.();
		}
	} catch (error) {
		console.warn("[cozyclay] could not open the asset store for project restore", error);
	}
	return restored;
}
