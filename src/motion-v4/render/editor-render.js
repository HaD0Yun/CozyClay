// The editor side of the v4 render tool: the live query v4_render (design 3.4). One render per cell
// from the cell's own camera, the cell's dots and label painted on, the tiles laid row-major into one
// PNG. Pure apart from ports (App.jsx: renderFrameBuffer answers bottom-up RGBA, encodePng a data
// URL). It answers the live query directly, not through an action receipt, so no 8 KiB cap applies.
import { tileRgba, paintDots, boxDownscaleRgba } from "../../studio-contact-sheet.js";
import { paintLabel } from "./font.js";

const MAX_SIDE = 2576, MAX_CELLS = 32, BLANK = 40;
const now = () => globalThis.performance?.now?.() ?? Date.now();
const finite = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

function checkCell(cell, i) {
	if (cell === null) return;
	const bad = what => { throw new Error(`v4_render cells[${i}]: ${what}.`); };
	if (!Number.isInteger(cell?.frame) || cell.frame < 0) bad("frame must be an integer >= 0");
	if (!finite(cell.eye, 3)) bad("eye must be 3 numbers");
	if (!finite(cell.quaternion, 4)) bad("quaternion must be 4 numbers");
	if (!(cell.fovDeg > 0 && cell.fovDeg < 180)) bad("fovDeg must be between 0 and 180");
	if (cell.fade !== undefined && !(Array.isArray(cell.fade) && cell.fade.every(id => typeof id === "string"))) bad("fade must be a list of record ids");
	if (cell.dots !== undefined && !Array.isArray(cell.dots)) bad("dots must be a list");
}

/** A copy of one cell's render at the tile size (the renderer may reuse its read-back buffer). */
function shotOf(cell, tile, ports) {
	const shot = ports.renderFrameBuffer(cell.frame, { eye: cell.eye, quaternion: cell.quaternion, fovDeg: cell.fovDeg, output: { width: tile.width, height: tile.height }, fade: cell.fade ?? [] });
	if (!shot?.data) throw new Error(`v4_render: the renderer gave no pixels for frame ${cell.frame}.`);
	if (shot.width === tile.width && shot.height === tile.height) return Uint8Array.from(shot.data);
	return boxDownscaleRgba(shot.data, shot.width, shot.height, tile.width, tile.height);
}

/**
 * renderV4Sheet({ tile: { width, height }, columns, cells }, ports) -> { dataUrl, width, height, cells, ms }
 * cells: [{ frame, eye, quaternion, fovDeg, label?, fade?, dots? } | null], at most 32, row-major;
 * null is an empty tile. Throws when the sheet would pass 2576 px on a side.
 */
export function renderV4Sheet(args, ports) {
	const t0 = now(), { tile, columns, cells } = args ?? {};
	if (!Number.isInteger(tile?.width) || !Number.isInteger(tile?.height) || tile.width < 1 || tile.height < 1) throw new Error("v4_render: tile needs an integer width and height.");
	if (!Number.isInteger(columns) || columns < 1) throw new Error("v4_render: columns must be an integer >= 1.");
	if (!Array.isArray(cells) || !cells.length) throw new Error("v4_render: cells must be a non-empty list.");
	if (cells.length > MAX_CELLS) throw new Error(`v4_render: at most ${MAX_CELLS} cells a sheet; got ${cells.length}.`);
	const rows = Math.ceil(cells.length / columns);
	if (tile.width * columns > MAX_SIDE || tile.height * rows > MAX_SIDE) throw new Error(`v4_render: a ${tile.width * columns}x${tile.height * rows} sheet passes ${MAX_SIDE} px on a side.`);
	cells.forEach(checkCell);
	const tiles = cells.map(cell => {
		if (cell === null) return new Uint8Array(tile.width * tile.height * 4).map((_, i) => (i % 4 === 3 ? 255 : BLANK));
		const data = shotOf(cell, tile, ports);
		if (cell.dots?.length) paintDots(data, tile.width, tile.height, cell.dots);
		if (cell.label) {
			const text = String(cell.label), scale = tile.width >= 300 && text.length * 12 + 4 <= tile.width ? 2 : 1;
			paintLabel(data, tile.width, tile.height, 0, 0, text, { scale, bottomUp: true });
		}
		return data;
	});
	const sheet = tileRgba(tiles, tile.width, tile.height, { columns, rows, bottomUp: true });
	const dataUrl = ports.encodePng(sheet.data, sheet);
	return { dataUrl, width: sheet.width, height: sheet.height, cells: cells.filter(Boolean).length, ms: Math.round(now() - t0) };
}
