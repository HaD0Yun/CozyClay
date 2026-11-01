// The Studio's agent binding: inspection, admission and the agent's commands
// over the editor's native state. App.jsx supplies the ports (reads, commits,
// history, the action registry); this module owns no React or renderer state.
import { taskTargetPorts } from "./bus-task-targets.js";
import { createCommandBus } from "./command-bus.js";
import { readElementDocument, elementReadback, elementPatchArgs, elementTarget, elementPatchReceipt } from "./commands/elements.js";
import { physicsKeyStamp } from "./motion/physics-review.js";
import { shotAtFrame } from "./cuts.js";
import { isProxyFigure } from "./scenes.js";
import { supportHeightForObject } from "./scene-objects.js";
import { studioAssetList } from "./studio-asset-list.js";
import { buildStudioContext, physicsFingerprintInput, studioEntityCursor, validateStudioCursor } from "./studio-agent-context.js";
import { createStudioCommandJournal, framingChecks, localTransformReadback, placementChecks, sampledFramingResult, studioObjectCatalogue } from "./studio-agent-commands.js";
import { verifyInstalledTake } from "./studio-agent-motion.js"; import { objectRowBounds } from "./studio-entity-bounds.js"; import { exportFramingInto } from "./studio-export-framing.js";
import { shotGeometryFacts } from "./studio-geometry-facts.js"; import { KIT_CATALOGUE } from "./kits/index.js";
import { STUDIO_TOOL_FAMILIES, StudioProtocolError, validateReceipt, validateStudioCommand, validateStudioIdentity, refusalCode } from "./studio-agent-protocol.js";
import { studioVisual, verifyLighting } from "./studio-motion-visual.js";
import { withEffectState } from "./effects/state.js"; import { hdrEnvironmentCatalogue } from "./stage-hdr-library.js";

// App-owned adapter: the shared command modules remain the only
// planners and validators. Ports below publish through the native editor stores.
export function createStudioAppBinding(ports) {
	const fail = (code, message) => { throw new StudioProtocolError(code, message); };
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	const identities = new WeakMap(); let identitySequence = 0, tokenSequence = 0;
	const motionStamps = new Map(), calibrationStamps = new Map();
	const identityOf = value => {
		if (!value || typeof value !== "object") return 0;
		if (!identities.has(value)) identities.set(value, ++identitySequence);
		return identities.get(value);
	};
	const stableStamp = (stamps, key) => {
		if (key === null) return 0;
		if (!stamps.has(key)) stamps.set(key, stamps.size + 1);
		return stamps.get(key);
	};
	const motionContentKey = value => {
		if (!value || typeof value !== "object") return null;
		if (typeof value.studioTakeId === "string" && value.studioTakeId) return value.studioTakeId;
				return `${value.frames ?? 0}:${value.fps ?? 0}`;
	};
	const calibrationContentKey = value => value && typeof value === "object" ? JSON.stringify(value) : null;
	const tokens = new Map(), receipts = new Map(), images = new Map();
	let owner = null, journal = null, actionBus = null;
	const domainKeys = new Map(), domainRevisions = {};
	let authoredKey, physicsKey, viewKey, observedSceneRevision = ports.revision.current;
	let physicsRevision = 0, viewRevision = 0;
	function refresh() {
		const document = Object.assign({}, ...(ports.storeDomains?.() ?? []).map(domain => domain.document()));
		const read = ports.read(), raw = { ...read, ...document, document, busy: Boolean(read.busy || actionBus?.uiGesture?.()) }; // busy: studio-busy.js
		const host = validateStudioIdentity(raw.host);
		if (!same(owner, host)) {
			owner = host; tokens.clear(); receipts.clear(); images.clear();
			authoredKey = physicsKey = viewKey = undefined;
			journal = createStudioCommandJournal({ host, isRetained: receipt => ports.isRetained(receipt) });
		}
		const characters = raw.characters.map(character => {
			const target = raw.targets.get(character.id);
			return { ...character, sessionMotion: identityOf(target?.motion),
				ik: physicsKeyStamp(target?.ikState?.keys ?? new Map()), rig: target?.rig?.uuid ?? null };
		});
		// Runtime motion, IK and rig fields are derived from the active editor
		// buffers, not authored document state. A fresh equivalent buffer object
		// must not advance the scene clock on a read.
		const authoredCharacters = raw.characters.map(({ sessionMotion, ik, rig, ...character }) => character);
		// The stage is authored state too: a key-light or environment edit from any
		// surface bumps the scene revision exactly like a cast or object edit.
		const authored = JSON.stringify([raw.objects, authoredCharacters, raw.shots, raw.frameCount, raw.stage, document]);
		if (authoredKey !== undefined && authoredKey !== authored && observedSceneRevision === ports.revision.current) ports.revision.current++;
		authoredKey = authored; observedSceneRevision = ports.revision.current;
		const liveIds = new Set([...raw.objects, ...raw.characters, ...raw.shots].map(row => row.id));
		for (const id of tokens.keys()) if (!liveIds.has(id)) tokens.delete(id);
		for (const entry of [...raw.objects, ...characters, ...raw.shots]) {
			// Display-only name/tint changes never revoke a motion target.
			const { name, subject, tint, identityImage, ...content } = entry;
			const key = JSON.stringify(content), previous = tokens.get(entry.id);
			if (!previous || previous.key !== key) tokens.set(entry.id, { key, token: `target-${++tokenSequence}`, incarnation: previous?.incarnation ?? crypto.randomUUID() });
		}
		const physical = physicsFingerprintInput({ floor: { model: "flat", y: 0 }, frameCount: raw.frameCount,
			objects: raw.objects.map(o => ({ id: o.id, renderer: o.renderer,
				position: { x: o.x, y: o.y ?? 0, z: o.z }, rotationDeg: { x: o.rotX ?? 0, y: o.rot ?? 0, z: o.rotZ ?? 0 },
				scale: { x: o.scaleX, y: o.scaleY, z: o.scaleZ }, footprint: o.footprint, height: o.height,
				supportY: supportHeightForObject(o), parentId: o.parent ?? null, attachment: o.attach ?? null, path: o.path ?? null, hidden: o.hidden === true })),
			characters: raw.characters.map(c => {
				const t = raw.targets.get(c.id), summary = characters.find(row => row.id === c.id);
				const motionKey = motionContentKey(t?.motion), calibrationKey = calibrationContentKey(t?.motion?.sceneCalibration);
				return { id: c.id, incarnation: tokens.get(c.id).incarnation, modelId: c.model ?? null,
					rigId: t?.rig?.uuid ?? null, rigReady: Boolean(t?.rig), hidden: Boolean(c.hidden),
					position: { x: c.x, y: c.y ?? 0, z: c.z }, yawDeg: c.rot ?? 0, scale: c.scale ?? 1,
					takeId: t?.motion?.studioTakeId ?? null, sessionMotionId: motionKey ? `motion-${motionKey}` : null,
					motionRevision: stableStamp(motionStamps, motionKey), calibrationRevision: stableStamp(calibrationStamps, calibrationKey),
					ikRevision: ports.ikRevision(c.id, summary.ik),
					waypoints: (c.layer?.waypoints ?? []).map(p => ({ frame: p.frame, position: { x: p.x, y: p.y ?? 0, z: p.z } })) };
			}) });
		const physicalKey = JSON.stringify(physical);
		if (physicsKey !== undefined && physicsKey !== physicalKey) physicsRevision++;
		physicsKey = physicalKey;
		const nextViewKey = JSON.stringify([raw.selection, raw.activeCharacterId, raw.selectedShotId, raw.view, raw.camera]);
		if (viewKey !== undefined && viewKey !== nextViewKey) viewRevision++;
		viewKey = nextViewKey;
		for (const [domain, value] of Object.entries({ objects: raw.objects, shot: raw.shots, stage: raw.stage, cast: authoredCharacters, motion: characters, ...document })) {
			const key = JSON.stringify(value);
			if (domainKeys.get(domain) !== key) domainRevisions[domain] = (domainRevisions[domain] ?? 0) + 1;
			domainKeys.set(domain, key);
		}
		return { ...raw, host, revision: ports.revision.current, physicsRevision, viewRevision, domainRevisions: { ...domainRevisions } };
	}
	function guard(id) {
		const raw = refresh(), token = tokens.get(id)?.token;
		if (!token) fail("STALE_TARGET", "The exact target no longer exists.");
		return { ...raw.host, targetId: id, token };
	}
	function readCommand() {
		const s = refresh();
		return { host: s.host, revision: s.revision, frame: s.view.frame, frameCount: s.frameCount,
			objects: s.objects, characters: s.characters, activeCharacterId: s.activeCharacterId,
			selectedShotId: s.selectedShotId, shotDocument: { shots: s.shots }, camera: s.camera, stage: s.stage,
			filmback: s.filmback, manual: s.manual, floorY: 0, busy: s.busy };
	}
	function entityProjection(s) {
		return [...s.characters.map(c => {
			const t = s.targets.get(c.id);
			return { id: c.id, kind: "character", token: tokens.get(c.id).token, name: c.subject || c.id,
				position: { x: c.x, y: c.y ?? 0, z: c.z }, yawDeg: c.rot ?? 0, scale: c.scale ?? 1, tint: c.tint ?? null, modelId: c.model ?? null,
				motion: { takeId: t?.motion?.studioTakeId ?? null, frames: t?.motion?.frames ?? 0,
					ikKeyCount: t?.ikState?.keys.size ?? 0 },
				capabilities: { rigReady: Boolean(t?.rig), ik: Boolean(t?.rig?.userData?.poseBind), measuredFeet: false },
				characterKind: isProxyFigure(c) ? "proxy" : "rig", ...(isProxyFigure(c) ? { posture: c.posture ?? "stand" } : {}) };
		}), ...s.objects.map(o => { const local = localTransformReadback(o, s.objects); return { id: o.id, kind: "object", token: tokens.get(o.id).token, name: o.name || o.id,
			position: { x: o.x, y: o.y ?? 0, z: o.z }, yawDeg: o.rot ?? 0,
			rotationDeg: { x: o.rotX ?? 0, y: o.rot ?? 0, z: o.rotZ ?? 0 }, scale: { x: o.scaleX, y: o.scaleY, z: o.scaleZ },
			renderer: o.renderer, color: o.color ?? null, bounds: objectRowBounds(o, s, ports), ...(o.assetId ? { assetId: o.assetId } : {}),
			parentId: o.parent ?? null, attachment: o.attach ?? null, pathPointCount: o.path?.points.length ?? 0,
			// the dots on the route, with the lean (degrees) a mark carries
			...(o.path?.marks?.length ? { pathMarks: o.path.marks.map(mark => typeof mark === "number" ? mark : { t: mark.t, ...(mark.bank !== undefined ? { bank: mark.bank } : {}), ...(mark.pitch !== undefined ? { pitch: mark.pitch } : {}) }) } : {}), ...(local ? { local } : {}) }; })];
	}
	const frameRange = row => ({ startFrame: row.startFrame, endFrameExclusive: row.endFrame + 1 });
	function context() {
		const s = refresh(), entities = entityProjection(s), registry = ports.actions?.();
		const shot = s.shots.find(row => row.id === s.selectedShotId) ?? shotAtFrame(s.shots, s.view.frame), cast = id => s.characters.some(c => c.id === id);
		const range = frameRange;
		return buildStudioContext({ schema: "studio-context-v1", host: { surface: "studio", ...s.host, workspaceHandle: s.workspaceHandle },
			revision: { scene: s.revision, physics: s.physicsRevision, view: s.viewRevision },
			units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", pivot: "base", fps: 24, rangeEnd: "exclusive" },
			scene: { name: s.sceneName, aspect: s.aspect, floorY: 0, frameCount: s.frameCount, objectCount: s.objects.length, characterCount: s.characters.length, ...(s.previsMode ? { previsMode: s.previsMode } : {}), ...(s.castStyle ? { castStyle: s.castStyle } : {}) },
			// A removed character (the last one, too) is neither selected nor active.
			selection: ["character", "rig"].includes(s.selection?.kind) && !cast(s.selection.id) ? null : s.selection, activeCharacterId: cast(s.activeCharacterId) ? s.activeCharacterId : null, view: s.view,
			shot: shot ? { id: shot.id, name: shot.name, range: range(shot), mode: shot.camera?.mode ?? "keys" } : null, camera: s.camera,
			// buildStudioContext selects the detailed rows and writes the real page.
			entities, entityPage: { returned: 0, total: 0, truncated: false, nextCursor: null },
			shots: s.shots.map(row => ({ id: row.id, name: row.name, range: range(row), keyCount: row.cameraKeys.length })), shotsTruncated: false,
			assets: studioAssetList(s.objects), recentReceipts: [...receipts.values()].filter(r => r.ok).reverse().slice(0, 3).map(r => ({ id: r.receiptId, summary: r.status, canUndoDirect: ports.canUndo(r) })),
			jobs: [], capabilities: { profile: "studio-slice-1", tools: STUDIO_TOOL_FAMILIES,
				rigReady: Boolean(s.targets.get(s.activeCharacterId)?.rig), cameraReady: Boolean(s.camera), bridgeReady: s.bridgeReady,
				...(s.previsMode ? { storyboard: s.previsMode === "storyboard" } : {}) },
			// Every registered command; buildStudioContext keeps only its id/label index.
			...(registry ? { actions: registry.list() } : {}) });
	}
	function readEnvironment() {
		const s = refresh();
		return { host: s.host, physicsRevision: s.physicsRevision, floor: { model: "flat", y: 0 }, objects: s.objects, frameCount: s.frameCount,
			cast: s.characters.map(character => ({ character, ...s.targets.get(character.id) })) };
	}
	function remember(receipt) { if (receipt?.receiptId) receipts.set(receipt.receiptId, receipt); return receipt; }
	function rejection(request, error, phase = "admission") {
		// The refusal's own words are what the model acts on; the receipt keeps
		// the first 120 characters the protocol carries.
		const words = [...String(error?.message ?? "").trim()];
		return validateReceipt({ ok: false, commandId: request.commandId, host: request.host ?? request.binding?.host,
			code: refusalCode(error), phase, affectedIds: [], expectedTargets: [], currentTargets: [], mutated: false,
			preserved: { authoredState: "unchanged" }, recovery: { action: "inspect", retryAllowed: false },
			...(words.length ? { message: words.length > 120 ? `${words.slice(0, 119).join("")}…` : words.join("") } : {}) });
	}
	function admit(request) {
		const s = refresh();
		if (!same(validateStudioIdentity(request.host), s.host)) fail("STALE_SCENE", "The live document changed.");
		if (request.expectedRevision !== s.revision) fail("STALE_SCENE", "Authored state changed; obtain fresh intent.");
		if (s.busy) fail("TARGET_BUSY", "Finish the current editor gesture first.");
		return s;
	}
	/** Actual state of one action target after it ran. */
	function actionReadback(id, s, compact = false) {
		const patched = Object.entries(s.document).flatMap(([kind, value]) => {
			const target = elementTarget(kind, value, id, s.host.sceneId);
			return target ? elementReadback(kind, target) : [];
		});
		if (id === s.host.sceneId) return { selection: s.selection, activeCharacterId: s.activeCharacterId, shotId: s.selectedShotId, view: s.view,
			...(patched.length ? { patched } : {}) };
		const object = s.objects.find(row => row.id === id), entity = object ?? s.characters.find(row => row.id === id);
		// Beyond the transform an object's patched paths already carry: the world box it occupies (an empty: its
		// parts', as inspect's rows) and, for a group, who hangs off it. `compact` (a receipt near its size limit) drops back to the paths alone.
		// A character's box means cloning and posing its rig, too dear for every receipt or inspect row: verify has it.
		const extras = () => {
			if (!object || compact) return {};
			const childIds = s.objects.filter(row => row.parent === id).map(row => row.id);
			return { bounds: objectRowBounds(object, s, ports),
				...(childIds.length ? { childIds: childIds.slice(0, 12), ...(childIds.length > 12 ? { childCount: childIds.length } : {}) } : {}) };
		};
		if (patched.length) return { patched, ...extras() };
		// A camera key lives inside its shot: still present there means retained, not removed (#863).
		const shot = s.shots.find(row => row.id === id), key = !shot && !entity && s.shots.flatMap(row => row.cameraKeys?.map(k => ({ shotId: row.id, frame: k.frame, id: k.id })) ?? []).find(k => k.id === id);
		if (shot) return { name: shot.name || shot.id, range: { startFrame: shot.startFrame, endFrameExclusive: shot.endFrame + 1 } };
		if (!entity) return key ? { shotId: key.shotId, frame: key.frame } : { removed: true };
		const brief = { name: entity.name || entity.subject || entity.id, position: { x: entity.x, y: entity.y ?? 0, z: entity.z } };
		if (compact) return brief;
		if (!object) return { ...brief, yawDeg: entity.rot ?? 0, scale: entity.scale ?? 1, ...extras() };
		return { ...brief, rotationDeg: { x: object.rotX ?? 0, y: object.rot ?? 0, z: object.rotZ ?? 0 }, scale: { x: object.scaleX, y: object.scaleY, z: object.scaleZ },
			parentId: object.parent ?? null, ...extras() };
	}
	/** One registered Studio action, run for the agent through the same
	 * registry the UI controls call. A mutation is bound to the native history
	 * entry it pushed, so its receipt is an ordinary journal receipt that
	 * undo_edit reverts; a job answers "started" and lands later. */
	const patchRequests = new Map();
	function commandBus() {
		if (!actionBus) actionBus = createCommandBus({ registry: ports.actions(), ports: {
			read: refresh, journal: () => {
				const admitted = journal;
				return { ...admitted, record: receipt => {
					const patch = patchRequests.get(receipt.commandId);
					return admitted.record(patch ? elementPatchReceipt(receipt, patch, refresh().document) : receipt);
				} };
			}, recordAction: (...args) => ports.recordAction(...args), beginAction: (...args) => ports.beginAction(...args),
			readback: actionReadback, remember, receipt: id => receipts.get(id), isRetained: receipt => ports.isRetained(receipt),
			canUndo: receipt => ports.canUndo(receipt), undo: () => ports.undo(), redo: () => ports.redo(),
			history: redo => ports.history?.(redo), finishHistoryGesture: () => ports.finishHistoryGesture?.(), readTarget: id => { refresh(); return tokens.get(id)?.token; }, ...taskTargetPorts(ports),
			captureToasts: listener => ports.captureToasts?.(listener), showRefusal: message => ports.showRefusal?.(message), emit: event => ports.emitCommandEvent?.(event),
		} });
		return actionBus;
	}
	function runAction(request, args) {
		const { name: _name, args: _args, ...options } = request;
		const result = commandBus().run(args.action, args.args, { ...options, origin: "agent", turnId: request.turnId, taskId: request.taskId, confirmationToken: args.confirmationToken ?? request.confirmationToken });
		const answer = receipt => receipt.nextHost ? { ...receipt, host: receipt.nextHost } : receipt;
		return result?.then ? result.then(answer) : answer(result);
	}
	function execute(request) {
		refresh();
		if (request.name === "run_action") return runAction(request, validateStudioCommand({ name: request.name, args: request.args }).args);
		const alias = ports.actions?.().toolAlias?.(request.name);
		if (alias) {
			try { return runAction(request, { action: typeof alias.action === 'function' ? alias.action(request.args) : alias.action, args: alias.args(request.args) }); }
			catch (error) { return rejection(request, error); }
		}
		const patchKind = request.name === "patch_elements" && request.args?.ops?.[0]?.target?.kind;
		if (patchKind) {
			try {
				const args = elementPatchArgs(patchKind, request.args);
				patchRequests.set(request.commandId, request);
				return runAction(request, { action: `${patchKind}.set`, args });
			} catch (error) { return rejection(request, error); }
			finally { patchRequests.delete(request.commandId); }
		}
		const signature = JSON.stringify(request);
		if (!same(request.host, owner)) return rejection(request, new StudioProtocolError("STALE_SCENE", "Document changed."));
		try {
			if (!journal.begin(request.commandId, signature)) return journal.get(request.commandId);
			// Verification only observes: the document identity (checked above) is
			// its whole fence, so a later edit never refuses it.
			const { args } = validateStudioCommand({ name: request.name, args: request.args }), s = request.name === "verify_result" ? refresh() : admit(request);
			if (request.name === "verify_result") {
				const receipt = args.receiptId ? receipts.get(args.receiptId) : null;
				if (args.receiptId && !receipt) fail("STALE_TARGET", "Receipt is not retained in this document.");
				for (const id of args.targets ?? []) guard(id);
				// A receipt edited over since is still evidence of what it did: return it
				// marked stale with the revision it describes beside the current one.
				const evidenceRevision = receipt ? receipt.revision.after : s.revision;
				// Targets, and a receipt without evidence of its own, are measured now with
				// the helpers the arrange/frame_shot receipts and the motion candidate use.
				// Only a check nothing could compute is unsupported, and says why; a motion
				// check computed for some characters still names the ones it skipped.
				const scene = readCommand(), entityIds = ids => ids.filter(id => scene.objects.some(o => o.id === id) || scene.characters.some(c => c.id === id));
				// A receipt's checks are evidence only for what they measured: every receipt carries a coverage tag, but
				// only an arrange/frame receipt carries overlap or framing numbers. Anything else is measured here.
				const measuredBy = { placement: "overlapIds", framing: "screenFraction" }, unmeasured = receipt && args.checks.some(check => measuredBy[check] && receipt.checks?.[measuredBy[check]] === undefined);
				const measured = args.targets ? entityIds(args.targets) : unmeasured ? entityIds(receipt.affectedIds) : null;
				// A framing check also carries the cut's geometry, read from the scene: side of the action line
				// and sight lines per shot, the receipt's or targets' shots first (8 at most).
				const result = { receiptId: receipt?.receiptId ?? null, revision: s.revision, evidenceRevision, stale: evidenceRevision !== s.revision, checks: measured ? { coverage: "current-scene-targets" } : receipt.checks,
					verification: receipt?.verification ?? null, semanticStatus: "unavailable", visualRefs: [], unsupportedChecks: [], unsupportedReasons: {}, ...(args.checks.includes("framing") ? { geometry: shotGeometryFacts(scene, { first: receipt ? receipt.affectedIds : args.targets, ports: { bounds: ports.bounds } }) } : {}) }, reasons = result.unsupportedReasons, verified = [], skipped = [], pending = [];
				// Lighting is measured from the rendered shot frame (studio-lighting-check.js), never from a receipt.
				if (args.checks.includes("lighting")) verifyLighting(result, args.targets ?? receipt.affectedIds, scene, ports);
				for (const check of args.checks.filter(check => !["motion", "lighting"].includes(check) && measured)) {
					if (!measured.length) { reasons[check] = "No target is an object or character in the current scene."; continue; }
					try { result.checks[check] = check === "placement" ? placementChecks(measured, scene, { bounds: ports.bounds, takes: s.targets }) : framingChecks(measured, scene, { bounds: ports.bounds }); }
					catch (error) { if (!(error instanceof StudioProtocolError)) throw error; reasons[check] = error.message; }
				}
				if (args.checks.includes("framing") && args.range !== undefined && !args.rangeWasDefaulted) {
					const sampled = sampledFramingResult(args, scene, ports, s.frameCount, measured, receipt);
					if (sampled.reason) reasons.framing = sampled.reason; else result.checks.framing = sampled;
				}
				if (args.checks.includes("motion") && !receipt?.verification) {
					const subjects = args.targets ?? receipt.affectedIds.filter(id => s.characters.some(c => c.id === id));
					if (!subjects.length) skipped.push("The receipt affected no character.");
					subjects.forEach((id, index) => {
						const character = s.characters.find(c => c.id === id), target = s.targets.get(id), name = character?.subject || id;
						if (!character) return skipped.push(`${id} is not a character; motion checks a character's take.`);
						if (!target?.motion) return skipped.push(`${name} has no motion take to check.`);
						if (!target.rig) return skipped.push(`${name}'s rig is not loaded yet.`);
						pending.push(verifyInstalledTake({ target: { ...target, character }, environment: readEnvironment(), range: args.range === "whole_clip" ? undefined : args.range, poseCast: ports.poseCast })
							.then(verification => { verified[index] = verification; }, error => { if (!(error instanceof StudioProtocolError)) throw error; skipped.push(`${name}: ${error.message}`); }));
					});
				}
				if (args.checks.includes("motion")) exportFramingInto(result, { args, s, receipt, scene, ports }); if (args.visual !== "none") studioVisual(args, { s, receipt, result, images, ports, scene });
				const finish = () => {
					const computed = verified.filter(Boolean);
					if (computed.length) result.verification = computed.length === 1 ? computed[0] : computed;
					if (skipped.length) reasons.motion = skipped.join(" ");
					result.unsupportedChecks = args.checks.filter(check => reasons[check] && (check !== "motion" || !computed.length));
					return result;
				};
				if (!pending.length) return finish();
				// Motion evaluation yields between frames: answer when it settles, with the
				// same rejection receipt a synchronous failure would journal.
				return Promise.all(pending).then(finish).catch(error => {
					const rejected = rejection(request, error);
					return same(rejected.host, journal.host) ? journal.record(rejected) : rejected;
				});
			}
			fail("CAPABILITY_MISSING", "Generation is owned by the server runtime.");
		} catch (error) { const receipt = rejection(request, error); return journal.record(receipt); }
	}
	const handlers = {
		read_studio_context(request) { const c = context(); if (!same(validateStudioIdentity(request.host), owner)) fail("STALE_SCENE", "This is not the requested document."); return c; },
		inspect_studio(args) {
			const command = validateStudioCommand({ name: "inspect_studio", args }); const c = context();
			// Every scope carries the revision and document identity, not the whole
			// context (the turn already holds that, and resending it per call is what
			// the model pays for): the revision is what the agent's next command is
			// admitted at, so a scope without it leaves that admission stale.
			const head = { revision: c.revision, host: (({ workspaceId, documentEpoch, sceneId, sceneEpoch }) => ({ workspaceId, documentEpoch, sceneId, sceneEpoch }))(c.host) };
			if (command.args.scope === "catalogue") return { ...head, ...studioObjectCatalogue(), kits: KIT_CATALOGUE, environments: hdrEnvironmentCatalogue() };
			if (command.args.scope === "document") return { ...head, scope: "document",
				...readElementDocument(refresh().document, command.args, c.host.sceneId) };
			// Discovery for run_action: every registered action with its label, kind,
			// exposure and availability (the reason when unavailable). Schemas are on
			// request: ids answer those actions' full declarations, input included.
			if (command.args.scope === "actions") {
				const actions = (ports.actions?.()?.list() ?? []).filter(row => !row.agentHidden);
				return { ...head, actions: command.args.ids ? actions.filter(row => command.args.ids.includes(row.id)) : actions.map(({ input, description, ...row }) => row) };
			}
			const s = refresh();
			const wanted = row => (!args.ids || args.ids.includes(row.id)) && (!args.query || Boolean(row.name?.includes(args.query)));
			if (["scene", "shot", "motion", "selection"].includes(command.args.scope)) {
				const select = { shot: ["shot"], motion: ["motion", "character"] }[command.args.scope];
				const ids = args.ids ?? (command.args.scope === "selection" ? [s.selection?.id ?? s.host.sceneId]
					: args.query && select ? (command.args.scope === "shot" ? s.shots : entityProjection(s).filter(row => row.kind === "character")).filter(wanted).map(row => row.id) : undefined);
				return { ...head, scope: "document", ...readElementDocument(s.document, { ...command.args, ids, select, named: args.ids }, c.host.sceneId) };
			}
			// Build each page from the same complete authoritative projection; never
			// page by slicing an already-truncated Send context.
			// Stable id order, so an offset cursor survives unrelated edits.
			const filtered = entityProjection(s).filter(wanted).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
			const offset = args.cursor ? validateStudioCursor(args.cursor, c) : 0, limit = command.args.limit;
			// An effect row also carries its particles at the playhead (src/effects/state.js).
			return { ...head, entities: filtered.slice(offset, offset + limit).map(row => withEffectState(row, s.view.frame, s.objects)), total: filtered.length,
				nextCursor: offset + limit < filtered.length ? studioEntityCursor(c, offset + limit) : null };
		},
		operate_studio: request => execute({ ...request, name: "operate_studio" }),
		arrange_objects: request => execute({ ...request, name: "arrange_objects" }),
		arrange_characters: request => execute({ ...request, name: "arrange_characters" }),
		patch_elements: request => execute({ ...request, name: "patch_elements" }),
		frame_shot: request => execute({ ...request, name: "frame_shot" }),
		verify_result: request => execute({ ...request, name: "verify_result" }),
		undo_edit: request => runAction(request, { action: "edit.undo", args: request.args }),
		run_action: request => execute({ ...request, name: "run_action" }),
		resolve_studio_image(request) {
			refresh(); const image = images.get(request.imageId);
			if (!image || (request.receiptId && request.receiptId !== image.receiptId) || (request.revision !== undefined && request.revision !== image.revision)) fail("STALE_TARGET", "Image observation does not belong to this receipt.");
			return image;
		},
		reconcile_studio_command(request) { refresh(); const value = journal.reconcile({ commandId: request.commandId, host: request.host ?? request.binding?.host }); return value.status === "not_applied" ? { ...value, evidence: value.receipt } : value; },
	};
	function invalidate(domain, before, after) {
		if (before === after) return;
		if (domain === "pose") {
			const id = ports.read().activeCharacterId, previous = tokens.get(id);
			if (previous) tokens.set(id, { ...previous, key: null });
			return;
		}
		if (!["characters", "objects"].includes(domain) || !Array.isArray(before) || !Array.isArray(after)) return;
		const content = row => {
			if (!row) return null;
			const { subject, name, tint, identityImage, sessionMotion, ...rest } = row;
			return { ...rest, motionIdentity: identityOf(sessionMotion) };
		};
		for (const row of before) {
			const next = after.find(c => c.id === row.id), previous = tokens.get(row.id);
			if (!next) tokens.delete(row.id);
			else if (previous && !same(content(row), content(next))) tokens.set(row.id, { ...previous, key: null });
		}
	}
	return { handlers, context, guard, refresh, invalidate, get bus() { refresh(); return commandBus(); }, dispose: () => { actionBus?.dispose(); } };
}
