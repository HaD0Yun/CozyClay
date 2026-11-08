// Tile labels for v4 render sheets: a built-in 5x7 bitmap font, so the browser and Node draw the
// same pixels with no canvas and no font file. Characters: 0-9 a-z A-Z space : - / . _ #; any
// other character draws as a hollow box.
// FONT packs 8 characters per glyph: the character, then 7 rows top to bottom, each a base-32
// digit of 5 bits (16 = the left pixel).
const FONT = "0ehjlphe14c4444e2eh1248v3v2421he426aiv225vgu11he668guhhe7v1248888ehhehhe9ehhf12cAehhhvhhBuhhuhhuCehgggheDsihhhisEvgguggvFvggugggGehgnhhfHhhhvhhhIe44444eJ72222icKhikokihLggggggvMhrllhhhNhhpljhhOehhhhhePuhhugggQehhhlidRuhhukihSfgge11uTv444444UhhhhhheVhhhhha4WhhhlllaXhha4ahhYhhha444Zv1248gva00e1fhfbggmphhuc00egghed11djhhfe00ehvgef698s888g0fhhf1ehggmphhhi40c444ej20622ickggikokilc44444em00qllhhn00mphhho00ehhhep00uhuggq00djf11r00mpgggs00ege1ut88s8896u00hhhjdv00hhha4w00hhllax00ha4ahy00hhf1ez00v248v 0000000:0cc0cc0-000v000/01248g0.00000cc_000000v#aavavaa";
const GLYPHS = new Map();
for (let i = 0; i < FONT.length; i += 8) GLYPHS.set(FONT[i], [...FONT.slice(i + 1, i + 8)].map(c => parseInt(c, 32)));
const UNKNOWN = [31, 17, 17, 17, 17, 17, 31];
const ADVANCE = 6, ROWS = 7;

/** Width and height in pixels of `text` drawn by paintLabel with this scale and pad. */
const labelSize = (text, scale, pad) => [pad * 2 + Math.max(0, [...text].length * ADVANCE - 1) * scale, pad * 2 + ROWS * scale];

/**
 * Paint `text` on an RGBA buffer on a dark strip whose top-left corner is pixel (x, y), counted from
 * the image's top row. bottomUp (default true, WebGL read-back order) says the buffer's rows run
 * bottom-up. Nothing outside the strip changes. Answers the strip { x, y, width, height }, clipped
 * to the image.
 */
export function paintLabel(data, width, height, x, y, text, { scale = 2, pad = 2, color = [255, 255, 255], background = [16, 16, 16], alpha = 0.72, bottomUp = true } = {}) {
	const [w0, h0] = labelSize(String(text), scale, pad);
	const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(width, x + w0), y1 = Math.min(height, y + h0);
	const put = (px, py, rgb, a) => {
		if (px < x0 || py < y0 || px >= x1 || py >= y1) return;
		const i = ((bottomUp ? height - 1 - py : py) * width + px) * 4;
		for (let k = 0; k < 3; k++) data[i + k] = Math.round(data[i + k] + (rgb[k] - data[i + k]) * a);
		data[i + 3] = 255;
	};
	for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) put(px, py, background, alpha);
	[...String(text)].forEach((ch, n) => {
		const rows = GLYPHS.get(ch) ?? UNKNOWN;
		for (let r = 0; r < ROWS; r++) for (let c = 0; c < 5; c++) {
			if (!(rows[r] & (16 >> c))) continue;
			const gx = x + pad + (n * ADVANCE + c) * scale, gy = y + pad + r * scale;
			for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(gx + sx, gy + sy, color, 1);
		}
	});
	return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
