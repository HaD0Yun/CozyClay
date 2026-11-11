// Reference images for sculpt comparison: read a PNG or JPEG from a path into
// RGBA, and write a PNG back. PNG is decoded here (zlib + the five filters);
// JPEG goes through jpeg-js. Nothing is sent to a model — the pixels become a
// silhouette mask on this machine.
import { constants as fsConstants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import jpeg from "jpeg-js";

import { normalizeMeshPath } from "./mesh-file.mjs";

const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
	const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA, palette) to RGBA. */
export function decodePng(bytes) {
	const buf = Buffer.from(bytes);
	if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
	let offset = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, transparency = null;
	const idat = [];
	while (offset + 8 <= buf.length) {
		const length = buf.readUInt32BE(offset), kind = buf.toString("latin1", offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + length);
		if (kind === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			depth = data[8];
			type = data[9];
			interlace = data[12];
		} else if (kind === "PLTE") palette = data;
		else if (kind === "tRNS") transparency = data;
		else if (kind === "IDAT") idat.push(data);
		else if (kind === "IEND") break;
		offset += 12 + length;
	}
	if (!width || !height) throw new Error("PNG has no image header");
	if (width * height > MAX_PIXELS) throw new Error(`image is too large (${width}x${height})`);
	if (depth !== 8 || interlace !== 0) throw new Error("only 8-bit non-interlaced PNGs are supported; re-save it or use a JPEG");
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
	if (!channels) throw new Error(`unsupported PNG colour type ${type}`);
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y += 1) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x += 1) {
			const a = x >= channels ? pixels[y * stride + x - channels] : 0;
			const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
			const value = line[x];
			pixels[y * stride + x] = (filter === 0 ? value : filter === 1 ? value + a : filter === 2 ? value + b : filter === 3 ? value + ((a + b) >> 1) : value + paeth(a, b, c)) & 0xff;
		}
	}
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i += 1) {
		const s = i * channels, d = i * 4;
		if (type === 3) {
			const index = pixels[s];
			rgba[d] = palette?.[index * 3] ?? 0; rgba[d + 1] = palette?.[index * 3 + 1] ?? 0; rgba[d + 2] = palette?.[index * 3 + 2] ?? 0;
			rgba[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
		} else if (type === 0 || type === 4) {
			rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
			rgba[d + 3] = type === 4 ? pixels[s + 1] : 255;
		} else {
			rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2];
			rgba[d + 3] = type === 6 ? pixels[s + 3] : 255;
		}
	}
	return { width, height, data: rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(kind, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(kind, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** RGBA to a PNG buffer (filter 0, deflate level 6). */
export function encodePng(width, height, rgba) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; header[9] = 6;
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y += 1) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
	return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A PNG or JPEG from a local path (file:// and ~/ accepted) as RGBA. */
export async function readImageFromPath(raw) {
	const path = normalizeMeshPath(raw);
	let file;
	try {
		file = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(`Could not read the reference image: ${error.message}`);
	}
	try {
		const stat = await file.stat();
		if (stat.isDirectory()) throw new Error("The reference path is a directory, not an image.");
		if (stat.size > REFERENCE_MAX_BYTES) throw new Error(`The reference image is larger than ${REFERENCE_MAX_BYTES / (1024 * 1024)} MB.`);
		const bytes = await file.readFile();
		if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(bytes);
		if (bytes[0] === 0xff && bytes[1] === 0xd8) {
			const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 512 });
			return { width: image.width, height: image.height, data: image.data };
		}
		throw new Error("The reference must be a PNG or a JPEG.");
	} finally {
		await file.close();
	}
}
