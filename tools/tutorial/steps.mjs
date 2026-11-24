// Runs one episode step against the page: input actions through cursor.mjs,
// teaching overlays through overlay.mjs, the install scene through
// terminal.mjs, and the Studio itself.
import { actionOf, joinTexts, localizeTarget, readingMs } from "./episode.mjs";
import { playTerminal } from "./terminal.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const CLOSING_TITLE = { ko: "이번 영상에서 본 것", en: "What we covered" };
const CHAPTER = { ko: (number) => `챕터 ${number}`, en: (number) => `Chapter ${number}` };

/** Runs on every new document, before the Studio's own scripts read the store: the chosen UI language, and the Agent
 * pane folded while no choice is stored. The Studio opens with the pane unfolded; the episodes were written for the
 * folded one (they point at its bar and open it themselves with Cmd/Ctrl+B). Neither key makes the load a returning one. */
export const localeScript = (origin, locale) => `if (location.origin === ${JSON.stringify(origin)}) { try { localStorage.setItem("cozyclay.locale", ${JSON.stringify(locale)}); if (!localStorage.getItem("cozyclay.shell.agent-pane.v1")) localStorage.setItem("cozyclay.shell.agent-pane.v1", "folded"); } catch {} }`;

/** Empty origin storage (no project session, no saved projects), then the Studio and its project chooser. A first open
 * goes straight to the editor, so the chooser the episodes start on is opened through File > New. */
export async function openStudio(cdp, url) {
	const origin = new URL(url).origin;
	// Navigates, and waits until that page is the document: the next load event can still be the page before it.
	const go = async (to, there) => {
		const loaded = cdp.once("Page.loadEventFired");
		await cdp.send("Page.navigate", { url: to });
		await loaded;
		for (let tries = 0; tries < 100; tries += 1) {
			if (await cdp.evaluate(`document.readyState === "complete" && (${there})`).catch(() => false)) return;
			await sleep(100);
		}
		throw new Error(`the page never reached ${to}`);
	};
	// A Studio still open on the origin could write its session back after the clear.
	if ((await cdp.evaluate("location.origin")) === origin) await go("about:blank", 'location.href === "about:blank"');
	await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
	// The Studio saves its scene as it leaves, and that write can land after the clear. A stored scene is no first open
	// (src/guest-start.js): the Studio would open it with no project. A page of the origin that is not the Studio
	// empties what is left; the new-document script then sets the language again.
	await go(`${origin}/favicon.ico`, 'location.pathname === "/favicon.ico"');
	await cdp.evaluate("localStorage.clear()");
	await go(url, `location.pathname === ${JSON.stringify(new URL(url).pathname)}`);
	if (!(await cdp.waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline') && !!localStorage.getItem('cozyclay.project-session.v1')", 30000))) throw new Error(`the Studio's first open never reached the editor (stored: ${await cdp.evaluate("Object.keys(localStorage).join(', ')")})`);
	await cdp.evaluate("document.querySelector('[data-testid=menu-file]')?.click()");
	if (!(await cdp.waitFor("!!document.querySelector('[data-testid=menubar-new]')", 10000))) throw new Error("the File menu never showed New");
	await cdp.evaluate("document.querySelector('[data-testid=menubar-new]').click()");
}

/** An action value with every target in it resolved for the UI language. */
function localizeStep(value, local) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(local);
	if (Object.hasOwn(value, "from")) return { from: local(value.from), to: Number.isFinite(value.to?.dx) ? value.to : local(value.to) };
	if (Object.hasOwn(value, "open")) return { open: local(value.open), then: local(value.then) };
	if (Object.hasOwn(value, "into")) return { ...value, into: local(value.into) };
	return local(value);
}

/** The words a card shows, in `locale`. */
function cardContent(step, { episode, chapter, locale }) {
	const titled = episode.chapters.filter((item) => item.title);
	if (step.card === "opening") return { eyebrow: "CozyClay", title: episode.title[locale], subtitle: episode.subtitle?.[locale] };
	// Titles that carry their own number ("2 · Layout tour") are listed as they are.
	const titles = titled.map((item) => item.title[locale]);
	const items = titles.length ? { titles, numbered: !titles.every((title) => /^\d/.test(title)) } : null;
	if (step.card === "closing") return { title: CLOSING_TITLE[locale], items };
	// A title that already carries its number ("2 · Layout tour") gets no "Chapter N" above it.
	const number = episode.chapters.indexOf(chapter) + episode.firstChapter;
	const title = step.card.title[locale];
	if (step.card.chapters) return { title, subtitle: step.card.subtitle?.[locale], items };
	return { eyebrow: chapter.title && !/^\d/.test(title) ? CHAPTER[locale](number) : null, title, subtitle: step.card.subtitle?.[locale] };
}

/** Reading time of a card in the video's language, for its default hold (2 s at least). */
function cardReadingMs(step, context, wps) {
	const { eyebrow, title, subtitle, items } = cardContent(step, context);
	const words = [eyebrow, title, subtitle, ...(items?.titles ?? [])].filter(Boolean).join(" ");
	return Math.max(2000, readingMs({ [context.locale]: words }, wps, context.locale));
}

/**
 * Run `step`. `context` carries { cdp, input, wps, locale, url, episode, chapter }:
 * the normalized episode and the chapter the step belongs to.
 */
export async function runStep(context, step) {
	const { cdp, input, wps, url } = context;
	const action = actionOf(step);
	const local = (target) => localizeTarget(target, context.locale);
	const value = ["click", "wait", "spotlight", "drag", "menu", "type"].includes(action) ? localizeStep(step[action], local) : step[action];
	if (action === "click") for (const target of Array.isArray(value) ? value : [value]) await input.click(target);
	else if (action === "type") await input.type(value);
	else if (action === "key") await input.key(value);
	else if (action === "drag") await input.drag(value.from, value.to);
	else if (action === "hold") await sleep(value);
	else if (action === "eval") {
		const result = await cdp.evaluate(`(async () => (${value}))()`);
		if (result?.ok === false) throw new Error(`step ${step.id}: eval returned ${JSON.stringify(result)}`);
	} else if (action === "wait") {
		if (typeof value === "number") await sleep(value);
		else if (!(await input.locate(value, 20000))) throw new Error(`step ${step.id}: ${JSON.stringify(value)} never showed`);
	} else if (action === "spotlight") {
		if (value === null) {
			await cdp.evaluate("window.__tutorialOverlay.clear()");
			await sleep(350);
		} else {
			// The rect is read now, after any menu or scroll the earlier steps opened.
			if (step.glide !== false) await input.hover(value);
			const shown = await cdp.evaluate(`window.__tutorialOverlay.spotlight(${JSON.stringify(value)}, ${JSON.stringify(step.label?.[context.locale] ?? "")}, ${JSON.stringify(step.note?.[context.locale] ?? "")})`);
			if (!shown) throw new Error(`step ${step.id}: ${JSON.stringify(value)} is not on the page`);
			await sleep(step.hold ?? readingMs(joinTexts(step.label, step.note), wps, context.locale));
		}
	} else if (action === "menu") {
		await input.click(value.open);
		await input.click(value.then);
	} else if (action === "card") {
		await cdp.evaluate("window.__tutorialOverlay.clear()");
		await cdp.evaluate(`window.__tutorialOverlay.card(${JSON.stringify(cardContent(step, context))})`);
		await sleep(step.hold ?? cardReadingMs(step, context, wps));
		await cdp.evaluate("window.__tutorialOverlay.hideCard()");
		await sleep(350);
	} else if (action === "terminal") {
		await playTerminal(cdp, value);
		await sleep(step.hold ?? 1500);
	} else if (action === "studio") {
		await openStudio(cdp, url);
		if (!(await cdp.waitFor("document.querySelector('.v2-start-screen')", 20000))) throw new Error(`step ${step.id}: the project chooser never showed`);
	}
	if (step.until && !(await cdp.waitFor(`!!window.__tutorialFind(${JSON.stringify(local(step.until))})`, 20000))) {
		throw new Error(`step ${step.id}: ${JSON.stringify(step.until)} never showed`);
	}
}
