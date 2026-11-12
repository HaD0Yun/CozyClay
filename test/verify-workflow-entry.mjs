#!/usr/bin/env node
// #1211: the Workflow canvas is unfinished, so the Studio hides its two entry
// points (the Window menu link and a panel card's "Send to Workflow" button
// with its send menu). One exported switch decides both; it ships off, and the
// code behind the entries stays so turning the switch on restores them as-is.
import { existsSync, readFileSync } from "node:fs";
import { parseSync } from "vite";

const root = new URL("../", import.meta.url);
const SWITCH = "WORKFLOW_ENTRY_ENABLED";
const SWITCH_MODULE = "src/workflow-entry.js";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

function walk(node, visit, ancestors = []) {
	if (!node || typeof node !== "object") return;
	if (typeof node.type === "string") visit(node, ancestors);
	const next = typeof node.type === "string" ? [...ancestors, node] : ancestors;
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) value.forEach((child) => walk(child, visit, next));
		else if (value && typeof value === "object") walk(value, visit, next);
	}
}

const attr = (element, name) => element.openingElement.attributes
	.find((attribute) => attribute.type === "JSXAttribute" && attribute.name?.name === name)?.value?.value;

// Rendered only when the switch is on: some ancestor is `SWITCH && <...>`,
// with the element on the right-hand side of that `&&`.
function underSwitch(ancestors) {
	return ancestors.some((node, i) => node.type === "LogicalExpression" && node.operator === "&&"
		&& node.left.type === "Identifier" && node.left.name === SWITCH && ancestors[i + 1] === node.right);
}

function inspect(path) {
	const result = parseSync(path, readFileSync(new URL(path, root), "utf8"));
	if (result.errors.length) throw new Error(`${path}: ${result.errors.map((error) => error.message).join("; ")}`);
	const switchImports = [];
	const elements = [];
	walk(result.program, (node, ancestors) => {
		if (node.type === "ImportDeclaration" && node.specifiers.some((specifier) => specifier.imported?.name === SWITCH)) switchImports.push(node.source.value);
		if (node.type === "JSXElement") elements.push({ node, ancestors });
	});
	return { switchImports, elements };
}

const switchPath = new URL(SWITCH_MODULE, root);
expect(`${SWITCH_MODULE} holds the one Workflow entry switch`, existsSync(switchPath));
const switchModule = existsSync(switchPath) ? await import(switchPath.href) : {};
expect(`${SWITCH} is exported and ships off`, switchModule[SWITCH] === false);

// Both shell components read the SAME constant from the same module.
const menuBar = inspect("src/shell/MenuBar.jsx");
const boardSlot = inspect("src/shell/BoardSlot.jsx");
expect(`the menu bar reads ${SWITCH} from ${SWITCH_MODULE}`, menuBar.switchImports.length === 1 && menuBar.switchImports[0] === "../workflow-entry.js");
expect(`the panel card reads ${SWITCH} from ${SWITCH_MODULE}`, boardSlot.switchImports.length === 1 && boardSlot.switchImports[0] === "../workflow-entry.js");

// Window menu: the Workflow link and the separator that only set it apart
// from the Agent item render only under the switch.
const windowMenu = menuBar.elements.filter(({ ancestors }) => ancestors.some((node) => node.type === "Property" && node.key?.name === "window"));
const workflowLinks = menuBar.elements.filter(({ node }) => node.openingElement.name.name === "a" && String(attr(node, "className")).includes("workflow-topbar-link"));
const windowSeparators = windowMenu.filter(({ node }) => node.openingElement.name.name === "hr");
expect("the Window menu's Workflow link code stays in place", workflowLinks.length === 1 && attr(workflowLinks[0].node, "href") === "/workflow/");
expect("the Window menu's Workflow link renders only under the switch", workflowLinks.length > 0 && workflowLinks.every(({ ancestors }) => underSwitch(ancestors)));
expect("the Window menu leaves no separator outside the switch", windowSeparators.every(({ ancestors }) => underSwitch(ancestors)));

// Panel card: the "Send to Workflow" button and its stylized/greybox send menu.
const sendButtons = boardSlot.elements.filter(({ node }) => attr(node, "data-action") === "workflow");
const sendMenus = boardSlot.elements.filter(({ node }) => attr(node, "className") === "dock-board-menu");
const sendSources = boardSlot.elements.filter(({ node }) => ["stylized", "greybox"].includes(attr(node, "data-send-source")));
expect("the panel card's Send to Workflow code stays in place", sendButtons.length === 1 && sendMenus.length === 1 && sendSources.length === 2);
expect("the panel card's Send to Workflow button renders only under the switch", sendButtons.length > 0 && sendButtons.every(({ ancestors }) => underSwitch(ancestors)));
expect("the panel card's send menu renders only under the switch", sendMenus.length > 0 && [...sendMenus, ...sendSources].every(({ ancestors }) => underSwitch(ancestors)));

if (failures) {
	console.error(`${failures} Workflow entry check(s) failed`);
	process.exit(1);
}
console.log("Workflow entry points stay hidden behind one switch");
