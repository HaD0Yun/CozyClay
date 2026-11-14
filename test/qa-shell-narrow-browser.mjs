// QA_URL=<studio> CDP_PORT=<port> node tools/qa-browser.mjs -- node test/qa-shell-narrow-browser.mjs
import assert from "node:assert/strict";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const b = await cameraBrowser();
try {
	await b.navigate(new URL("/app/", b.base));
	await b.send("Page.bringToFront");
	await b.arm("!!window.__cozyclay?.editorCam && !!document.querySelector('.stage canvas')");
	await b.settled();
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await b.change("!!document.querySelector('.dock-shot-look')", () => b.click('[data-fid="shot_add"]'));
	await b.change("!!document.querySelector('.vp-look-through-exit')", () => b.click(".dock-shot-look"));
	for (const width of [390, 768, 1180, 1440]) {
		await b.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
		for (const theme of ["light", "dark"]) {
			await b.evaluate("document.querySelector('[data-testid=menu-edit]').focus()");
			await b.change("!!document.querySelector('[data-testid=menu-preferences]')", () => b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }));
			await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
			await b.change("!!document.querySelector('.v2-preferences__dialog')", () => b.click("[data-testid=menu-preferences]"));
			await b.click(`[data-testid="settings-theme-${theme}"]`);
			await b.change("!document.querySelector('.v2-preferences__dialog')", () => b.click("[data-testid=preferences-close]"));
			const state = await b.evaluate(`(() => {
				const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
				const luminance = color => {
					const rgb = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
					return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
				};
				const pill = document.querySelector('.vp-look-through-exit'), style = getComputedStyle(pill);
				const fg = luminance(style.color), bg = luminance(style.backgroundColor);
				const hint = getComputedStyle(pill.querySelector('.vp-exit-hint')), alpha = Number(hint.opacity);
				const background = style.backgroundColor.match(/[\\d.]+/g).slice(0, 3).map(Number);
				const hintRgb = hint.color.match(/[\\d.]+/g).slice(0, 3).map((v, i) => Number(v) * alpha + background[i] * (1 - alpha));
				const hintLuminance = luminance('rgb(' + hintRgb.join(',') + ')');
				const frame = document.createElement('div');
				frame.style.cssText = 'position:absolute;pointer-events:none;left:var(--shell-center-left);right:var(--shell-center-right);top:var(--shell-stage-top);bottom:var(--shell-center-bottom)';
				document.querySelector('.app').appendChild(frame);
				const stage = frame.getBoundingClientRect(); frame.remove();
				return {
					dock: box('.studio-dock-slot'), menu: box('.menubar'), hud: box('.vp-look-through-exit'), mode: box('.vp-mode-toolbar'),
					stageSize: [stage.width, stage.height],
					contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05),
					hintContrast: (Math.max(hintLuminance, bg) + .05) / (Math.min(hintLuminance, bg) + .05),
					scrollWidth: document.documentElement.scrollWidth
				};
			})()`);
			for (const [name, rect] of Object.entries({ dock: state.dock, menu: state.menu, hud: state.hud })) {
				assert.ok(rect.width > 0 && rect.x >= 0 && rect.right <= width + 1 && rect.y >= 0 && rect.bottom <= 845, `${width} ${theme}: ${name} fits: ${JSON.stringify(rect)}`);
			}
			assert.ok(state.stageSize[0] >= 280 && state.stageSize[1] >= 160, `${width} ${theme}: stage remains open: ${state.stageSize}`);
			assert.ok(state.contrast >= 4.5 && state.hintContrast >= 4.5, `${width} ${theme}: HUD and exit hint contrast: ${state.contrast}, ${state.hintContrast}`);
			assert.ok(state.hud.top >= state.mode.bottom, `${width} ${theme}: HUD does not cover the mode toolbar`);
			assert.ok(state.scrollWidth <= width, `${width} ${theme}: no page overflow`);
			console.log(`PASS ${width} ${theme}: stage, timeline, menus and shot HUD (${state.contrast.toFixed(2)}:1)`);
		}
		if (width <= 1000) {
			await b.change("document.querySelector('.app').dataset.narrowPanel === 'outliner'", () => b.click('[aria-controls="shell-outliner"]'));
			await b.click('[role="treeitem"][data-node-id="camera"]');
			await b.change("document.querySelector('.app').dataset.narrowPanel === 'details'", () => b.click('[aria-controls="shell-details"]'));
			await b.evaluate(`document.querySelector('[data-testid="camera-performance-record"]').scrollIntoView({ block: 'nearest' })`);
			const controls = await b.evaluate(`(() => {
				const record = document.querySelector('[data-testid="camera-performance-record"]'), r = record.getBoundingClientRect();
				const panel = document.querySelector('.studio-right-column').getBoundingClientRect();
				const dock = document.querySelector('.studio-dock-slot').getBoundingClientRect();
				const rail = document.querySelector('.vp-overlay-rail').getBoundingClientRect();
				return { reachable: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === record,
					record: r.toJSON(), panel: panel.toJSON(), dock: dock.toJSON(), rail: rail.toJSON() };
			})()`);
			assert.ok(controls.reachable, `${width}: Camera performance can be reached by scrolling Details`);
			assert.ok(controls.panel.bottom <= controls.dock.top && controls.rail.bottom <= controls.panel.top + 1, `${width}: panel, tool rail and timeline do not overlap: ${JSON.stringify(controls)}`);
			await b.change("!document.querySelector('.app').hasAttribute('data-narrow-panel')", () => b.click('[aria-controls="shell-details"]'));
			console.log(`PASS ${width}: Outliner and Details navigation, Camera performance reachable`);
			await b.evaluate("document.querySelector('[data-testid=menu-window]').focus()");
			await b.change("!!document.querySelector('[data-testid=menu-agent]')", () => b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }));
			await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
			await b.change("!!document.querySelector('.studio-agent-inspector:not([hidden])')", () => b.click("[data-testid=menu-agent]"));
			const agent = await b.evaluate(`(() => {
				const box = s => document.querySelector(s).getBoundingClientRect().toJSON();
				return { panel: box('.studio-right-column'), header: box('.studio-agent-inspector .agent-header'),
					composer: box('.studio-agent-inspector .agent-composer'), dock: box('.studio-dock-slot') };
			})()`);
			for (const rect of [agent.header, agent.composer]) {
				assert.ok(rect.width > 0 && rect.height > 0 && rect.top >= agent.panel.top && rect.bottom <= agent.panel.bottom + 1 && rect.right <= width, `${width}: Agent controls fit the panel: ${JSON.stringify(agent)}`);
			}
			assert.ok(agent.panel.bottom <= agent.dock.top, `${width}: expanded Agent does not cover the timeline`);
			await b.change("!document.querySelector('.app').hasAttribute('data-narrow-panel')", () => b.click(".studio-agent-collapse"));
			console.log(`PASS ${width}: Agent opens and collapses without covering stage or timeline`);
		}
	}
	console.log("narrow shell browser: all checks passed");
} finally {
	b.close();
}
