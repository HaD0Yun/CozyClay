#!/usr/bin/env node
// User-visible copy in the Studio shell and the stage defaults: toasts and
// tooltips speak to the operator in every locale, without storage keys,
// provider names or the retired "Subject 1" numbering.
import { readFileSync } from "node:fs";
import { ZH } from "../src/locale-zh.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
let failures = 0;
function expect(name, condition, detail = "") {
	if (condition) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
	}
}

// The ko(...) call that holds `needle`, split into its literal arguments.
function koCall(source, needle) {
	const at = source.indexOf(needle);
	if (at < 0) return null;
	const start = source.lastIndexOf("ko(", at);
	const literal = /\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*([,)])/y;
	const args = [];
	literal.lastIndex = start + 3;
	for (let match; (match = literal.exec(source));) {
		args.push(match[1] ?? match[2]);
		if (match[3] === ")") break;
	}
	return { start, args };
}

const app = read("src/App.jsx");
{
	const call = koCall(app, "Motion job ${payload.status}.");
	const toast = app.slice(app.indexOf("Motion job ${payload.status}.") - 120, app.indexOf("Motion job ${payload.status}.") + 160);
	expect(
		"the motion-job toast fallback has Korean and Chinese text",
		call !== null && toast.includes("ko(`Motion job") && call.args.length === 3 && /[가-힯]/.test(call.args[1]) && /[㐀-鿿]/.test(call.args[2]),
		toast.trim(),
	);
}

const defaults = read("src/stage-startup-defaults.js");
{
	const presets = defaults.slice(defaults.indexOf("export const SHOT_ASPECT_PRESETS"), defaults.indexOf("});", defaults.indexOf("export const SHOT_ASPECT_PRESETS")));
	const titles = [...presets.matchAll(/title: ([^}]+?) \}\)/g)].map((match) => match[1]);
	expect("the aspect presets carry tooltips", titles.length === 2, JSON.stringify(titles));
	for (const title of titles) {
		expect(`the aspect tooltip is translated: ${title}`, /^ko\("[^"]+", "[^"]*[가-힯][^"]*", "[^"]*[㐀-鿿][^"]*"\)$/.test(title));
		expect(`the aspect tooltip names no tool or provider: ${title}`, !/inbetweener|\bFal\b|\bH3\b/i.test(title));
	}
}
{
	const call = koCall(defaults, "Saved scenes were unreadable");
	expect("the unreadable-scenes toast is a three-locale ko() call", call?.args.length === 3, JSON.stringify(call?.args));
	for (const [index, text] of (call?.args ?? []).entries()) {
		expect(`the unreadable-scenes toast shows no storage key (argument ${index + 1})`, !/SCENES_QUARANTINE_KEY|cozyclay\./.test(text), text);
	}
}

const cast = read("src/domains/cast.js");
{
	const call = koCall(cast, "Root path on — click the set floor");
	const [en, koText, zhText] = call?.args ?? [];
	expect("the root-path toast drops the Subject numbering in English", !!en && !/\bSubject \d/.test(en), en);
	expect("the root-path toast keeps its Korean text", koText === "루트 경로 켜짐 — 샷 뷰의 세트 바닥을 클릭해 웨이포인트를 놓으세요. 인물 1이 0프레임 시작점입니다", koText);
	expect(
		"the root-path toast keeps its Chinese text",
		(zhText ?? ZH[en]) === "根路径已开启 — 在镜头视图中点击布景地面放置路径点；角色 1 是第 0 帧的起点",
		zhText ?? ZH[en],
	);
}

if (failures) {
	console.error(`${failures} app copy check(s) failed`);
	process.exit(1);
}
console.log("all app copy checks PASS");
