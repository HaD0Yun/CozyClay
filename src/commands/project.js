import { studioActionDeclaration } from "../studio-actions.js";
import { fail } from "./shared.js";
import { CAST_STYLES, PREVIS_MODES } from "../project.js";

const input = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const name = { type: "string", minLength: 1, maxLength: 240 };
const token = { type: "string", minLength: 1, maxLength: 240 };
const document = (id, label, properties = {}) => ({ id, label, description: label, kind: "document", exposure: "confirm", input: input(properties) });
const rename = { id: "project.rename", label: "Rename project", description: "Rename the project in one retained undo entry.", kind: "mutation", undoDomain: "scenes", input: input({ name }, ["name"]) };
// The deadline covers the user in the file picker, so it is the hub's ceiling, not the 30 s default (#834, #1207).
const PICKER_TIMEOUT_MS = 300_000;
const save = { ...studioActionDeclaration("project.save"), input: input({ name }), timeoutMs: PICKER_TIMEOUT_MS };
const saveAs = { ...save, id: "project.saveAs", label: "Save project as" };
const exportAsAnimation = { ...studioActionDeclaration("project.exportAsAnimation"), timeoutMs: PICKER_TIMEOUT_MS };
const opening = { ...document("project.open", "Open a project file", { serialized: { type: "string", maxLength: 400_000_000 }, handleToken: token, projectToken: token }), timeoutMs: PICKER_TIMEOUT_MS };
const fresh = document("project.new", "Start a new project", { name, previsMode: { type: "string", enum: [...PREVIS_MODES] }, castStyle: { type: "string", enum: [...CAST_STYLES] } });
const starter = document("project.openStarter", "Open a starter project", { id: token, source: { type: "string", enum: ["starter", "launch"] }, name, castStyle: { type: "string", enum: [...CAST_STYLES] } });
const restore = { ...document("project.restore", "Restore the remembered project", { handleToken: token }), exposure: "ui-only" };
const browse = { id: "project.browse", label: "Browse projects", description: "Show the project browser.", kind: "transient", exposure: "ui-only", input: input() };
export const declarations = Object.freeze([rename, save, saveAs, exportAsAnimation, opening, fresh, starter, restore, browse]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain?.("scenes");
	const available = () => Boolean(owner()) || "The project document owner is not mounted.";
	registry.register({ ...rename, available, run: ({ name }) => {
		if (!name.trim()) fail("INVALID_ARGUMENT", "A project name cannot be blank.");
		owner().renameProject(name);
		return { affectedIds: [owner().metadata().activeSceneId], summary: "Renamed project." };
	} });
	for (const declaration of [save, saveAs]) registry.register({ ...declaration, available: () => true,
		requiresConfirmation: state => {
			const project = owner()?.fileState() ?? state.project;
			return project.hasFile || project.fileAccess;
		},
		run: async (args, context) => {
			const project = owner()?.fileState() ?? ports.state().project;
			const as = declaration.id === "project.saveAs";
			if (context.origin !== "ui" && !project.gesture && project.name !== null && project.fileAccess) {
				if (as || !project.hasFile) fail("TARGET_NOT_READY", "Only the user's click can open the file picker. Ask them to press Save Project.");
				if (!(await ports.projectFileGranted())) fail("TARGET_NOT_READY", "The browser needs the user's click to re-grant access to the project file.");
			}
			const saved = owner() ? await owner().save({ ...args, saveAs: as }, context) : await ports.saveProject(as);
			if (saved?.naming) fail("TARGET_NOT_READY", "Not saved: the project has no name yet. The Save dialog is open for the user.");
			// A cancel the user asked for is not a refusal (#1041): CANCELLED is never counted as studio:refused.
			if (saved?.cancelled) fail("CANCELLED", "Not saved: the user closed the file picker.");
			if (!saved?.saved) fail("TARGET_NOT_READY", saved?.failure === "missing-resources" ? "Not saved: some project assets or motions are missing."
				: saved?.failure === "resources-too-large" ? "Not saved: the project's resources are too large." : "Not saved: writing the project file failed.");
			return { affectedIds: [], output: { fileName: saved.fileName }, summary: saved.downloaded
				? `This browser has no file access, so the project ${saved.name} was downloaded as ${saved.fileName}.`
				: `Saved the project ${saved.name} to ${saved.fileName}.` };
		} });
	registry.register({ ...exportAsAnimation, available: () => true,
		run: async (_args, context) => {
			const saved = await owner().exportAsAnimationProject(context);
			if (saved?.cancelled) fail("CANCELLED", "Not exported: the user closed the file picker.");
			if (!saved?.saved) fail("TARGET_NOT_READY", saved?.failure === "not-storyboard"
				? "Export as Animation project is available only for storyboard projects."
				: "Not exported: writing the animation project file failed.");
			return { affectedIds: [], output: { fileName: saved.fileName }, summary: saved.downloaded
				? `This browser has no file access, so the animation project ${saved.name} was downloaded as ${saved.fileName}.`
				: `Exported the storyboard as ${saved.name} to ${saved.fileName}.` };
		} });
	for (const declaration of [opening, fresh, starter, restore, browse]) registry.register({ ...declaration,
		available, run: async (args, context) => {
			const result = await owner().projectAction(declaration.id, args, context);
			// "cancelled": the user closed the picker or kept their unsaved changes; false: a real failure, already shown.
			if (result === "cancelled") fail("CANCELLED", "The project was not opened: the user cancelled.");
			if (result === false) fail("TARGET_NOT_READY", "The project was not opened; check the project dialog.");
			return { affectedIds: [owner().metadata().activeSceneId], output: { opened: result === true }, summary: `${declaration.label}.` };
		} });
}
