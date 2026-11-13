#!/usr/bin/env node
// Simplified Chinese option locale verification.
//
// English stays the default UI; Chinese is opt-in only when the saved
// localStorage choice is "zh", exactly like Korean. This harness:
//   1. imports locale.js with a polyfilled localStorage and exercises the
//      en / ko / zh three-way contract through ko();
//   2. checks every literal English default in the source has a ZH entry in
//      the central dictionary (locale-zh), so no menu or panel silently falls
//      back to English;
//   3. keeps Chinese copy out of English defaults and out of bare strings.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readStudioSource } from "./bus/verify-domain-modules.mjs";

const CJK = /[\u3400-\u9FFF]/;

function source(path) {
	return path === "src/App.jsx" ? readStudioSource() : readFileSync(path, "utf8");
}

function filesUnder(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...filesUnder(path));
		else if (/\.(js|jsx)$/.test(entry.name)) files.push(path);
	}
	return files;
}

function unescapeDouble(text) {
	try {
		return JSON.parse(`"${text}"`);
	} catch {
		return text;
	}
}

function unescapeSingle(text) {
	return text.replace(/\\(['\\])/g, "$1");
}

// Every ko("en", "ko") literal pair — both the two-argument form resolved by
// the dictionary and three-argument calls that carry their own Chinese text.
function literalKoPairs() {
	const pairs = [];
	for (const file of filesUnder("src")) {
		const relativePath = file.replaceAll("\\", "/");
		if (relativePath.startsWith("src/locale-zh")) continue;
		const text = source(relativePath);
		const pattern = /ko\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
		for (const match of text.matchAll(pattern)) {
			// A third argument carries its own Chinese text and needs no dictionary entry.
			const rest = text.slice(match.index + match[0].length);
			if (/^\s*,/.test(rest)) continue;
			const en = match[1] !== undefined ? unescapeDouble(match[1]) : unescapeSingle(match[2]);
			const line = text.slice(0, match.index).split("\n").length;
			pairs.push({ file: relativePath, line, en });
		}
	}
	return pairs;
}

const { ZH } = await import(pathToFileURL(resolve("src/locale-zh.js")).href);

// 1. Dictionary coverage: every literal English default must resolve in zh.
const pairs = literalKoPairs();
assert.ok(pairs.length > 900, `expected a large ko() surface, found ${pairs.length}`);
const missing = pairs.filter(({ en }) => !(en in ZH));
assert.equal(
	missing.length,
	0,
	`missing Chinese dictionary entries:\n${missing.slice(0, 12).map(({ en, file, line }) => `  ${file}:${line} ${JSON.stringify(en)}`).join("\n")}`,
);
for (const [en, zh] of Object.entries(ZH)) {
	assert.ok(zh.trim(), `empty Chinese text for ${JSON.stringify(en)}`);
	assert.doesNotMatch(en, CJK, `Chinese leaked into an English dictionary key: ${JSON.stringify(en)}`);
}

// 2. No Chinese as an English default anywhere in a ko() pair.
for (const { en, file, line } of pairs) {
	assert.doesNotMatch(en, CJK, `${file}:${line} has Chinese as the English ko() default: ${en}`);
}

// 3. Chinese copy stays inside locale constructs or the dictionary.
const TABLE_FILES = new Set([
	"src/use-case-question.jsx",
	"src/shot-guides.js",
	"src/first-success-guide.jsx",
	"src/stage-hdr.js",
	"src/range-pin-panel.jsx",
	"src/character-kind.js",
	"src/settings-menu.jsx",
	"src/shell/preference-controls.jsx",
]);
for (const file of filesUnder("src")) {
	const relativePath = file.replaceAll("\\", "/");
	if (relativePath.startsWith("src/locale-zh") || TABLE_FILES.has(relativePath)) continue;
	const lines = source(relativePath).split("\n");
	lines.forEach((line, index) => {
		if (!CJK.test(line.replace(/\/\/.*$/, ""))) return;
		const neighborhood = lines.slice(Math.max(0, index - 2), index + 3).join("\n");
		assert.ok(
			/ko\(/.test(line) || /ko\(/.test(neighborhood) || /\bzh:|\bZH_|\bisZh\b|_ZH\b|\bzh\b/.test(line),
			`${relativePath}:${index + 1} — Chinese UI copy outside ko()/zh tables: ${line.trim()}`,
		);
	});
}

// 4. locale.js: three-way runtime contract.
async function loadLocaleModule(storedValue, storageThrows = false) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key) => {
				if (storageThrows) throw new Error("storage unavailable");
				return key === "cozyclay.locale" ? storedValue : null;
			},
			setItem() {},
			removeItem() {},
		},
	});
	Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { reload() {} } } });
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "zh-CN" } });
	try {
		const url = pathToFileURL(resolve("src/locale.js"));
		url.search = `verify=${storedValue}-${storageThrows}-${Math.random().toString(36).slice(2)}`;
		return await import(url.href);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else delete globalThis.localStorage;
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else delete globalThis.window;
		if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
		else delete globalThis.navigator;
	}
}

const defaultOnChineseBrowser = await loadLocaleModule(null);
assert.equal(defaultOnChineseBrowser.LOCALE, "en", "a Chinese browser still starts in English without a saved choice");
assert.equal(defaultOnChineseBrowser.isZh, false);

const invalid = await loadLocaleModule("zh-CN");
assert.equal(invalid.LOCALE, "en", "an invalid stored value falls back to English");

const unavailable = await loadLocaleModule(null, true);
assert.equal(unavailable.LOCALE, "en", "unavailable storage falls back to English");

const zh = await loadLocaleModule("zh");
assert.equal(zh.LOCALE, "zh");
assert.equal(zh.isKo, false);
assert.equal(zh.isZh, true);
assert.equal(zh.ko("Frame", "프레임", "帧"), "帧", "an explicit third argument wins");
assert.equal(zh.ko("Settings", "설정"), "设置", "the dictionary resolves two-argument pairs");
assert.equal(zh.ko("This string has no translation", "번역 없음"), "This string has no translation", "unknown copy falls back to English");

const ko = await loadLocaleModule("ko");
assert.equal(ko.ko("Settings", "설정", "设置"), "설정", "Korean still wins when it is the chosen locale");

const en = await loadLocaleModule("en");
assert.equal(en.ko("Settings", "설정", "设置"), "Settings");

const localeSource = source("src/locale.js");
assert.match(localeSource, /LOCALES = new Set\(\["en", "ko", "zh"\]\)/, "locale.js accepts zh");
assert.match(localeSource, /export const isZh = LOCALE === "zh"/, "locale.js exposes isZh");
assert.match(localeSource, /zhText \?\? ZH\[en\] \?\? en/, "zh falls back from the third argument to the dictionary to English");

// 5. Wiring: language pickers, first-run cue, document language.
assert.match(source("src/shell/preference-controls.jsx"), /切换到中文/, "Preferences names the switch in Chinese");
assert.match(source("src/shell/preference-controls.jsx"), /简体中文/, "Preferences offers 简体中文");
assert.match(source("src/main.jsx"), /LOCALE === "zh" \? "zh-CN" : LOCALE/, "the document language is zh-CN in Chinese");

// English metadata stays the default; the language is applied at runtime.
const manifest = JSON.parse(source("public/manifest.webmanifest"));
assert.equal(manifest.lang, "en");
assert.match(source("index.html"), /<html lang="en">/);

// Model-facing prompt contracts stay English.
assert.match(source("src/shot.js"), /Camera move:/);
assert.match(source("src/shot.js"), /Use the attached blocking frame ONLY/);

console.log(`all Chinese option locale checks PASS (${pairs.length} ko() pairs, ${Object.keys(ZH).length} dictionary entries)`);
