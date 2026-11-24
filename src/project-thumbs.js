// A small picture of each project's stage for the start screen's Recent work.
// The studio canvas keeps its drawing buffer (preserveDrawingBuffer), so the
// last rendered frame is read back after a save or an open and stored per
// project name in IndexedDB, beside the recents list it illustrates.
const DB_NAME = "cozyclay.project-thumbs.v1";
const STORE = "thumbs";
const WIDTH = 480;
const HEIGHT = 270;

function openDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function withStore(mode, run) {
	const db = await openDb();
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const request = run(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(request?.result);
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

export async function loadProjectThumb(name) {
	try {
		return (await withStore("readonly", (store) => store.get(name))) ?? null;
	} catch {
		return null;
	}
}

export async function removeProjectThumb(name) {
	try {
		await withStore("readwrite", (store) => store.delete(name));
	} catch {
		/* private mode etc. */
	}
}

// The viewport frame, cropped to 16:9 around its centre; null without a stage.
function viewportFrame() {
	const source = document.querySelector(".viewport .stage canvas");
	if (!source?.width || !source?.height) return null;
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
	const scale = Math.max(WIDTH / source.width, HEIGHT / source.height);
	const width = WIDTH / scale;
	const height = HEIGHT / scale;
	canvas.getContext("2d").drawImage(source, (source.width - width) / 2, (source.height - height) / 2, width, height, 0, 0, WIDTH, HEIGHT);
	return canvas;
}

function viewportBlob() {
	const frame = viewportFrame();
	return frame ? new Promise((resolve) => frame.toBlob(resolve, "image/webp", 0.82)) : Promise.resolve(null);
}

// The same picture as a PNG data URL, read now and stored nowhere: what the
// Studio reports to a host app after a brief (src/host-agent-brief.js). null
// when there is no stage to read.
export function stageThumbDataUrl() {
	try {
		return typeof document === "undefined" ? null : viewportFrame()?.toDataURL("image/png") ?? null;
	} catch {
		return null;
	}
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// `settle` waits for a just-applied project to paint before the read-back.
export async function captureProjectThumb(name, { settle = false } = {}) {
	if (!name || typeof document === "undefined") return false;
	try {
		if (settle) {
			await nextFrame();
			await nextFrame();
			await new Promise((resolve) => setTimeout(resolve, 400));
		}
		const blob = await viewportBlob();
		if (!blob) return false;
		await withStore("readwrite", (store) => store.put(blob, name));
		return true;
	} catch {
		return false;
	}
}
