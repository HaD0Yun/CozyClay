#!/usr/bin/env node
// Korean option locale verification.
//
// English is always the default UI; Korean is opt-in only when the saved
// localStorage choice is "ko". Browser language must never select it. This
// harness is a static file check, so it cannot set localStorage before the
// page loads and locale.js exposes no URL/script injection hook. Instead:
//   1. import locale.js in node with a polyfilled localStorage to exercise
//      both the en default and the ko option through ko() deterministically;
//   2. verify Korean UI copy survives in the source, but only inside
//      ko("en", "ko") pairs, isKo branches, or the *_KO mapping tables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readStudioSource } from "./bus/verify-domain-modules.mjs";

function source(path) {
	return path === "src/App.jsx" ? readStudioSource() : readFileSync(path, "utf8");
}

function includesAll(path, values) {
	const text = source(path);
	for (const value of values) assert.ok(text.includes(value), `${path} is missing Korean UI copy: ${value}`);
}

// Every ko() pair must carry a non-empty English default and a non-empty
// Korean option.
function assertKoPairsHaveBothSides(path) {
	const text = source(path);
	const pairs = [...text.matchAll(/ko\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g)];
	assert.ok(pairs.length > 0, `${path} has no ko("en", "ko") pairs to verify`);
	for (const [, en, koText] of pairs) {
		assert.ok(en.trim(), `${path} has an empty English default in ko(): ${koText}`);
		assert.ok(koText.trim(), `${path} has an empty Korean option in ko(): ${en}`);
	}
}

// Korean may only appear inside ko(...) calls, isKo branches, or the
// *_KO mapping tables — never as bare Korean in JSX or strings.
function assertKoreanInsideLocaleConstructs(path) {
	const lines = source(path).split("\n");
	let inKoTable = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/const\s+[A-Za-z0-9_]*_KO\s*=\s*\{/.test(line)) inKoTable = true;
		if (inKoTable && /^\s*};?\s*$/.test(line)) inKoTable = false;
		if (!/[\uAC00-\uD7AF]/.test(line.replace(/\/\/.*$/, ""))) continue;
		assert.ok(
			inKoTable || /ko\(/.test(line) || /\bisKo\b/.test(line),
			`${path}:${index + 1} — Korean UI copy outside ko()/isKo/KO table: ${line.trim()}`
		);
	}
}

// locale.js reads localStorage at module scope, so a fresh dynamic import with
// polyfilled browser globals exercises the default and saved-choice contracts.
async function loadLocaleModule(storedValue, browserLanguage = "ko-KR", storageThrows = false) {
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
	Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: browserLanguage } });
	try {
		const url = pathToFileURL(resolve("src/locale.js"));
		url.search = `verify=${storedValue}-${browserLanguage}-${storageThrows}-${Math.random().toString(36).slice(2)}`;
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

const defaultOnKoreanBrowser = await loadLocaleModule(null, "ko-KR");
assert.equal(defaultOnKoreanBrowser.LOCALE, "en", "a Korean browser still starts in English without a saved choice");
assert.equal(defaultOnKoreanBrowser.isKo, false);

const invalidStoredLocale = await loadLocaleModule("ko-KR", "ko-KR");
assert.equal(invalidStoredLocale.LOCALE, "en", "an invalid stored value falls back to English");

const unavailableStorageLocale = await loadLocaleModule(null, "ko-KR", true);
assert.equal(unavailableStorageLocale.LOCALE, "en", "unavailable storage falls back to English");

const localeSource = source("src/locale.js");
assert.doesNotMatch(localeSource, /navigator\.language/, "browser language must not choose the default locale");
assert.match(localeSource, /stored\(\) \?\? "en"/, "English remains the no-choice fallback");

const enLocale = await loadLocaleModule("en");
assert.equal(enLocale.LOCALE, "en");
assert.equal(enLocale.isKo, false);
assert.equal(enLocale.ko("Frame", "프레임"), "Frame");
assert.equal(enLocale.ko("Collapse timeline", "타임라인 접기"), "Collapse timeline");

const koLocale = await loadLocaleModule("ko");
assert.equal(koLocale.LOCALE, "ko");
assert.equal(koLocale.isKo, true);
assert.equal(koLocale.ko("Frame", "프레임"), "프레임");
assert.equal(koLocale.ko("Collapse timeline", "타임라인 접기"), "타임라인 접기");

// Files converted to the English-default + Korean-option pattern.
for (const path of ["src/result-modal.jsx", "src/hierarchy-panel.jsx", "src/object-catalog.jsx", "src/error-boundary.jsx"]) {
	assertKoreanInsideLocaleConstructs(path);
	assertKoPairsHaveBothSides(path);
}

// The PR's Korean copy is preserved, now living inside the locale constructs.
// The language choice moved into the Settings menu (#193); its Korean copy —
// and the first-run "한국어" cue — travelled with it.
includesAll("src/settings-menu.jsx", ["한국어로 전환", "한국어", "Switch to English", "설정"]);
includesAll("src/result-modal.jsx", ["장면이 준비됐어요", "프롬프트 복사", "프레임 내보내기", "AI에 넣는 순서", "AI에 이미지 첨부"]);
// "재생 보기" was the PlayView centre tab's label; the tabs are gone (#195)
// and look-through now flies the shot camera from the camera bar / PiP.
includesAll("src/App.jsx", ["장면", "샷 카메라 시점으로 보기", "속성", "변환", "카메라 레일 완성"]);
includesAll("src/hierarchy-panel.jsx", ["이름 바꾸기", "장면 구조", "장면 계층", "프레임 맞추기", "장면 선택", "+ 새 장면", "장면은 최소 하나 필요합니다"]);
includesAll("src/motion/timeline.jsx", ["애니메이션 타임라인", "타임라인 펼치기"]);
includesAll("src/posestudio.jsx", ["포즈 스튜디오", "포즈 적용", "포즈 저장"]);
includesAll("src/motion/waypoints.js", ["핀 사이에는 최소", "자연스럽게 걷기엔 너무 느려요", "이전 구간보다 속도가"]);

// English is the default, so the document and manifest metadata are English.
const manifest = JSON.parse(source("public/manifest.webmanifest"));
assert.equal(manifest.lang, "en");
assert.match(source("index.html"), /<html lang="en">/);

// English remains intentional in the model-facing prompt contract.
assert.match(source("src/shot.js"), /Camera move:/);
assert.match(source("src/shot.js"), /Use the attached blocking frame ONLY/);

console.log("all Korean option locale checks PASS");
