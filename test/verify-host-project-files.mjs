#!/usr/bin/env node
// Project files owned by a host app (#1319, src/host-project-files.js): with
// window.cozyclayHost.projectFiles present, the project file functions in
// src/project.js open and save through the host; without it they are the
// browser's own, unchanged.
import assert from "node:assert/strict";

const files = new Map([["t-open", "{\"opened\":true}"]]);
const calls = [];
let openAnswer = { token: "t-open", name: "Chase.cclayproject" };
let saveAnswer = (fileName) => ({ token: "t-save", name: fileName });
let openListener = null;
const host = {
	pickForOpen: async () => { calls.push(["pickForOpen"]); return openAnswer; },
	pickForSave: async (fileName) => { calls.push(["pickForSave", fileName]); return saveAnswer(fileName); },
	read: async (token) => { calls.push(["read", token]); return { text: files.get(token), lastModified: 42 }; },
	write: async (token, text) => { calls.push(["write", token]); files.set(token, text); },
	onOpen: (listener) => { openListener = listener; return () => { openListener = null; }; },
};
const nativeHandle = { name: "Native.cclayproject", queryPermission: async () => "prompt", requestPermission: async () => { calls.push(["requestPermission"]); return "granted"; } };
globalThis.window = { cozyclayHost: { projectFiles: host } };

const project = await import("../src/project.js");
const { pickProjectToOpen } = await import("../src/project-open-file.js");
const { subscribeHostProjectOpen } = await import("../src/host-project-files.js");
const memory = (entries = []) => { const values = new Map(entries); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }; };

{
	assert.equal(project.hasFileSystemAccess(), true, "the host's files count as file access, with no browser picker at all");
	const handle = await project.pickProjectFileForSave("Chase");
	assert.deepEqual(calls.at(-1), ["pickForSave", "Chase.cclayproject"], "the host's save dialog suggests the file name");
	assert.deepEqual(handle, { hostToken: "t-save", name: "Chase.cclayproject" });
	assert.deepEqual(structuredClone(handle), handle, "the handle is plain data, so IndexedDB keeps it in the recent list and the last-project record");
	await project.writeProjectFile(handle, "{\"saved\":1}");
	assert.equal(files.get("t-save"), "{\"saved\":1}", "Save writes the whole file through the host");
	assert.deepEqual(await project.readProjectFile(handle), { name: "Chase", text: "{\"saved\":1}", savedAt: 42 });
	assert.equal(await project.queryHandlePermission(handle), "granted");
	assert.equal(await project.requestHandlePermission(handle), "granted");
	console.log("PASS save picks, writes and reads back through the host");
}
{
	calls.length = 0;
	// The flag an unreadable browser picker once left behind does not hide the host's dialog.
	const opened = await pickProjectToOpen(memory([["cozyclay.open-picker-unreadable", "1"]]), { isActive: false });
	assert.deepEqual(calls, [["pickForOpen"], ["read", "t-open"]]);
	assert.deepEqual(opened.handle, { hostToken: "t-open", name: "Chase.cclayproject" }, "the opened file keeps its handle, so Save writes back to it");
	assert.equal(opened.file.text, "{\"opened\":true}");
	console.log("PASS open uses the host's dialog and keeps the file to save back to");
}
{
	openAnswer = null;
	await assert.rejects(project.pickProjectFileForOpen(), { name: "AbortError" }, "a cancelled host dialog reads as the user closing the picker");
	saveAnswer = () => null;
	await assert.rejects(project.pickProjectFileForSave("Chase"), { name: "AbortError" });
	openAnswer = { token: "", name: "Chase.cclayproject" };
	await assert.rejects(project.pickProjectFileForOpen(), TypeError, "a malformed host answer is refused at the boundary");
	console.log("PASS a cancelled or malformed host dialog is handled like the browser's");
}
{
	const opened = [];
	const unsubscribe = subscribeHostProjectOpen((handle) => opened.push(handle));
	const warn = console.warn;
	console.warn = () => {};
	try {
		openListener({ token: "t-open", name: "Chase.cclayproject" });
		openListener({ name: "no token" });
	} finally {
		console.warn = warn;
	}
	assert.deepEqual(opened, [{ hostToken: "t-open", name: "Chase.cclayproject" }], "the host's open request arrives as a handle; a malformed one is dropped");
	unsubscribe();
	assert.equal(openListener, null);
	console.log("PASS the host can ask the Studio to open a project");
}
{
	// A plain browser: no bridge, or one missing a method, is no bridge.
	const hostHandle = { hostToken: "t-save", name: "Chase.cclayproject" };
	for (const cozyclayHost of [undefined, { projectFiles: { ...host, write: undefined } }]) {
		calls.length = 0;
		globalThis.window = { cozyclayHost, showSaveFilePicker: async () => nativeHandle, showOpenFilePicker: async () => [nativeHandle] };
		assert.equal(await project.pickProjectFileForSave("Chase"), nativeHandle, "the browser's picker is used as before");
		assert.equal(await project.pickProjectFileForOpen(), nativeHandle);
		assert.equal(await project.requestHandlePermission(nativeHandle), "granted");
		assert.deepEqual(calls, [["requestPermission"]], "a browser handle still asks the browser for permission");
		assert.equal(await project.queryHandlePermission(hostHandle), "denied", "a host file remembered without its host cannot be restored");
		assert.equal(await project.requestHandlePermission(hostHandle), "denied");
		await assert.rejects(project.readProjectFile(hostHandle), /host app that owns this project file/);
		assert.equal(typeof subscribeHostProjectOpen(() => {}), "function");
	}
	globalThis.window = {};
	assert.equal(project.hasFileSystemAccess(), false, "no bridge and no pickers is still no file access");
	console.log("PASS without a host bridge the browser's file access is unchanged");
}
