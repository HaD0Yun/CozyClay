import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
	addEdge,
	Background,
	Controls,
	Handle,
	Panel,
	Position,
	useEdgesState,
	useNodesState,
} from "reactflow";
import { FiActivity, FiBox, FiCode, FiFileText, FiFilm, FiImage, FiLink, FiMusic, FiPlay, FiPlus, FiUpload, FiVideo, FiType } from "react-icons/fi";
import { Toaster, toast } from "react-hot-toast";
import { loadWorkflowGraph, normalizeWorkflowGraph, storeWorkflowGraph, WORKFLOW_STORAGE_KEY } from "../project.js";
import AgentPanel from "./AgentPanel.jsx";
import CozySceneNode from "./CozySceneNode.jsx"; import { saveExport } from "../export-workspace.js";
import { applyCozyScenePatch, normalizeCozySceneData, sceneConnectionAllowed } from "./cozy-scene-node.js";
import { activeSceneCharacters, characterHandleId, characterIdFromHandle, normalizeMotionInputData, motionInputOutput, parseMotionSpec } from "./motion-input.js";
import { DEFAULT_NODE_SCHEMAS, defaultFormValues, schemaCategoryForType, schemaModelEntries, schemaProperties } from "./node-schema.js";
import { executeLocalWorkflowGraph } from "./local-workflow.js";
import { createLiveControl } from "../live-control.js";
import { bucketCount, bucketMs, track } from "../analytics.js";
import { startWorkflowExecution } from "../execution-telemetry.js";
import { createCanvasCommands } from "./canvas-commands.js";
import { applyMotionToActiveScene, importImageIntoActiveScene, readStoredSceneDocument } from "./scene-asset-sync.js";
import { createHttpTransport } from "./agent-client.js";
import { canvasTakesPaste, fileToDataUrl, imageFileFromTransfer, pastedImageNodeData } from "./clipboard-image.js";
import { appendVersion, compareIndex, pinnedInputs, selectVersion, versionLabel, versionState } from "./image-versions.js";
import { normalizeVideoForm, videoFormContract } from "./video-contract.js";
import ShotPromptNode from "./ShotPromptNode.jsx";
import { shotPromptFromInputs, shotPromptNodeData } from "./shot-prompt-node.js"; import { characterName } from "../character-name.js";

const NODE_COLORS = { text: "#6c7cff", image: "#44c2a4", video: "#d9955b", audio: "#6bb6dc", api: "#cf8de8", "video-combiner": "#efb064", upload: "#a88cdb", concat: "#d6b55e", "motion-input": "#79b5ed", scene: "#ef759d", "shot-prompt": "#8fd4b0" };

function makeNode(type, id, position, model = null, nodeSchemas = DEFAULT_NODE_SCHEMAS) {
	const data = { label: type === "scene" ? "CozyClay Scene" : type === "shot-prompt" ? "Shot Prompt" : type[0].toUpperCase() + type.slice(1) };
	Object.assign(data, { cost: 0, outputHistory: [], outputs: [], resultUrl: null, isLoading: false, errorMsg: null });
	if (type === "text") data.prompt = "Describe a shot for your scene...";
	if (type === "image") data.model = "image-passthrough";
	if (type === "video") data.prompt = "Describe the motion and camera treatment";
	if (type === "audio") data.prompt = "Describe the voice or music";
	if (type === "api") { data.model = "api-model"; data.params = "{}"; }
	if (type === "video-combiner") { data.model = "video-combiner"; data.videos_list = []; data.aspect_ratio = "auto"; }
	if (type === "concat") data.model = "prompt-concatenator";
	if (type === "motion-input") Object.assign(data, normalizeMotionInputData({ label: "Motion Input" }));
	if (type === "shot-prompt") Object.assign(data, shotPromptNodeData());
	if (model?.id) {
		data.model = model.id;
		data.selectedModel = { id: model.id, name: model.name };
		data.formValues = defaultFormValues(schemaProperties(nodeSchemas, schemaCategoryForType(type), model.id));
	}
	if (type === "scene") Object.assign(data, normalizeCozySceneData({ sceneName: "CozyClay Scene" }));
	return { id, type, position, data };
}

const DEFAULT_GRAPH = {
	version: 1,
	nodes: [makeNode("text", "text-1", { x: 80, y: 100 }), makeNode("image", "image-1", { x: 380, y: 80 }), makeNode("scene", "scene-1", { x: 700, y: 140 })],
	edges: [],
};

function readGraph() {
	const graph = loadWorkflowGraph();
	if (!graph.nodes.length) return DEFAULT_GRAPH;
	return { ...graph, nodes: graph.nodes.map((node) => node.type === "video-combiner" && !node.data?.model ? { ...node, data: { ...node.data, model: "video-combiner" } } : node) };
}

function captureSceneFrame(id) {
	return new Promise((resolve, reject) => {
		const iframe = document.querySelector(`[data-node-id="${CSS.escape(id)}"] iframe`);
		if (!iframe?.contentWindow) { reject(new Error("Scene preview is unavailable.")); return; }
		const timer = window.setTimeout(() => { window.removeEventListener("message", onMessage); reject(new Error("Scene capture timed out.")); }, 10000);
		const onMessage = (event) => {
			if (event.source !== iframe.contentWindow || event.data?.type !== "cozyclay:capture-framing-result") return;
			window.clearTimeout(timer); window.removeEventListener("message", onMessage);
			if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data);
		};
		window.addEventListener("message", onMessage);
		iframe.contentWindow.postMessage({ type: "cozyclay:capture-framing" }, "*");
	});
}

function stripFunctions(value) {
	if (Array.isArray(value)) return value.map(stripFunctions);
	if (!value || typeof value !== "object") return typeof value === "function" ? undefined : value;
	return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "function").map(([key, item]) => [key, stripFunctions(item)]));
}

function serializableGraph(nodes, edges) {
	return normalizeWorkflowGraph({
		version: 1,
		nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data: stripFunctions(data) })),
		edges: edges.map(({ id, source, target, sourceHandle, targetHandle, data }) => ({ id, source, target, sourceHandle, targetHandle, data: stripFunctions(data) })),
	});
}

function NodeShell({ id, type, title, icon: Icon, children, source = true, target = true }) {
	return <div className={`workflow-node workflow-node-${type}`}>
		{target && <Handle type="target" position={Position.Left} id="input" className="workflow-handle target" />}
		<div className="workflow-node-header"><span className="workflow-node-icon"><Icon size={15} /></span><strong>{title}</strong><span className="workflow-node-id">{id.replace(/\D/g, "") || "1"}</span></div>
		<div className="workflow-node-body">{children}</div>
		{source && <Handle type="source" position={Position.Right} id="output" className="workflow-handle source" />}
	</div>;
}

function categorySchemas(data, category) {
	return data.nodeSchemas?.categories?.[category]?.models || {};
}

function ModelSelect({ id, data, category, fallback = [], allowedModels = null }) {
	const allModels = categorySchemas(data, category);
	const models = allowedModels ? Object.fromEntries(allowedModels.filter((modelId) => allModels[modelId]).map((modelId) => [modelId, allModels[modelId]])) : allModels;
	const options = Object.keys(models).length ? Object.entries(models).map(([value, schema]) => ({ value, label: schema.name || value.replace(/-/g, " ") })) : fallback.map((value) => ({ value, label: value.replace(/-/g, " ") }));
	return <select aria-label="Model" value={data.model || options[0]?.value || ""} onChange={(event) => { const model = { id: event.target.value, ...(models[event.target.value] || {}) }; if (data.onModelChange) data.onModelChange(id, category, model); else data.onChange?.(id, { model: model.id, selectedModel: model }); }}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

function SchemaFields({ id, data, category, exclude = [] }) {
	const model = data.model || data.selectedModel?.id;
	const schema = categorySchemas(data, category)?.[model]?.input_schema;
	const properties = schema?.schemas?.input_data?.properties || schema?.properties || {};
	const visibleProperties = Object.entries(properties).filter(([key, field]) => !exclude.includes(key) && (!String(model || "").includes("passthrough") || field.type === "boolean"));
	if (!visibleProperties.length) return null;
	const values = data.formValues && typeof data.formValues === "object" ? data.formValues : {};
	const update = (key, value) => data.onChange?.(id, { formValues: { ...values, [key]: value }, [key]: value });
	return <div className="workflow-schema-fields"><span className="workflow-schema-title">Model inputs</span>{visibleProperties.map(([key, field]) => {
		const label = field.title || field.description || key.replace(/_/g, " ");
		const value = values[key] ?? data[key] ?? field.default ?? (field.type === "array" ? [] : "");
		if (Array.isArray(field.enum)) return <label key={key}>{label}<select value={value} onChange={(event) => update(key, event.target.value)}>{field.enum.map((option) => <option key={String(option)} value={option}>{String(option)}</option>)}</select></label>;
		if (field.type === "boolean") return <label className="workflow-schema-check" key={key}><input type="checkbox" checked={Boolean(value)} onChange={(event) => update(key, event.target.checked)} />{label}</label>;
		if (field.type === "array" || field.type === "object" || field.format === "textarea" || String(field.description || "").length > 100) {
			const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
			return <label key={key}>{label}<textarea className="workflow-textarea" value={text} onChange={(event) => { let next = event.target.value; if (field.type === "array" || field.type === "object") { try { next = JSON.parse(next); } catch { /* keep editing text */ } } update(key, next); }} /></label>;
		}
		return <label key={key}>{label}<input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={value} placeholder={field.description || ""} onChange={(event) => update(key, field.type === "number" || field.type === "integer" ? Number(event.target.value) : event.target.value)} /></label>;
	})}</div>;
}

function NodeCost({ data }) {
	if (data.cost === undefined || data.cost === null) return null;
	return <span className="workflow-node-cost">{Number(data.cost) === 0 ? "Free" : `$${Number(data.cost).toFixed(3)}`}</span>;
}

function TextNode({ id, data }) {
	return <NodeShell id={id} type="text" title="Text" icon={FiType} target={false}><label>Model</label><ModelSelect id={id} data={data} category="text" fallback={["text-passthrough"]} /><label>Prompt</label><textarea className="workflow-textarea" value={data.prompt || ""} onChange={(event) => data.onChange?.(id, { prompt: event.target.value })} /><SchemaFields id={id} data={data} category="text" /><div className="workflow-node-foot"><span>Prompt input <NodeCost data={data} /></span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.(id)}><FiPlay size={12} /></button></div></NodeShell>;
}

// Every generation stays on the node as a version, so an author can walk back
// to an earlier take, flip between two of them, and regenerate against the
// same inputs instead of re-staging the shot.
function ImageVersions({ id, data }) {
	const { versions, index, current } = versionState(data);
	const [showCompare, setShowCompare] = useState(false);
	const other = compareIndex(data);
	const shown = showCompare ? versions[other] || current : current;
	const select = (next) => { setShowCompare(false); data.onChange?.(id, selectVersion(data, next)); };
	if (!versions.length) return null;
	return <div className="workflow-versions">
		<img
			className={`workflow-image-preview${data.abMode ? " workflow-ab-toggle" : ""}`}
			src={shown?.dataUrl}
			alt={`Generated image version ${(showCompare ? other : index) + 1}`}
			data-version-index={showCompare ? other : index}
			onClick={() => { if (data.abMode && versions.length > 1) setShowCompare((value) => !value); }}
		/>
		<div className="workflow-version-bar">
			<button type="button" aria-label="Previous version" disabled={index <= 0} onClick={() => select(index - 1)}>‹</button>
			<span className="workflow-version-count">v{versionLabel(data)}</span>
			<button type="button" aria-label="Next version" disabled={index >= versions.length - 1} onClick={() => select(index + 1)}>›</button>
			<button
				type="button"
				className={`workflow-version-ab${data.abMode ? " active" : ""}`}
				aria-pressed={Boolean(data.abMode)}
				disabled={versions.length < 2}
				onClick={() => { setShowCompare(false); data.onChange?.(id, { abMode: !data.abMode, abIndex: compareIndex(data) }); }}
			>A/B</button>
		</div>
		{data.abMode && versions.length > 1 && <label className="workflow-version-compare">Compare with<select aria-label="Compare version" value={other} onChange={(event) => { setShowCompare(false); data.onChange?.(id, { abIndex: Number(event.target.value) }); }}>{versions.map((version, position) => <option key={version.at ?? position} value={position} disabled={position === index}>v{position + 1}</option>)}</select></label>}
		<label className="workflow-schema-check workflow-version-pin"><input type="checkbox" checked={Boolean(data.pinReferences)} onChange={(event) => data.onChange?.(id, { pinReferences: event.target.checked })} />Pin refs</label>
		<button type="button" className="workflow-version-reuse" onClick={() => data.onUseAsReference?.(id, index)}>Use as reference</button>
	</div>;
}

function ImageNode({ id, data }) {
	const generated = data.model === "image-generation";
	const hasVersions = versionState(data).versions.length > 0;
	return <NodeShell id={id} type="image" title="Image" icon={FiImage}><label>Model</label><ModelSelect id={id} data={data} category="image" fallback={["image-passthrough", "image-generation"]} />{generated && hasVersions ? <ImageVersions id={id} data={data} /> : generated && data.resultUrl ? <img className="workflow-image-preview" src={data.resultUrl} alt="Generated workflow output" /> : <div className="workflow-dropzone"><FiImage size={18} /><span>{generated ? "Connect a Scene frame" : "Connect an image or prompt"}</span></div>}{generated && data.isLoading && <div className="workflow-hint">Generating image…</div>}{generated && data.errorMsg && <div className="workflow-error">{data.errorMsg}</div>}<SchemaFields id={id} data={data} category="image" /><div className="workflow-node-foot"><span>Image output <NodeCost data={data} /></span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.(id)} disabled={data.isLoading}><FiPlay size={12} /></button></div></NodeShell>;
}

function h3VerificationMetrics(preservation) {
	const worst = preservation?.worst;
	if (!worst || !Number.isFinite(Number(worst.p95Rgb))) return "";
	const edge = Number(worst.p95Rgb).toFixed(1);
	const global = Number.isFinite(Number(worst.globalP80Rgb)) ? ` · full-frame P80 ${Number(worst.globalP80Rgb).toFixed(1)} RGB` : "";
	const camera = Number.isFinite(Number(worst.cameraDriftPx)) ? ` · camera shift ${Number(worst.cameraDriftPx).toFixed(1)} px` : "";
	return ` · edge p95 ${edge} RGB${global}${camera}`;
}

function VideoNode({ id, data }) {
	const generated = data.model === "video-generation";
	const [providers, setProviders] = useState([]);
	useEffect(() => { if (generated) createHttpTransport().videoProviders().then((result) => setProviders(result.providers || [])).catch(() => {}); }, [generated]);
	const provider = data.formValues?.provider || data.provider || "comfy";
	const falModel = providers.find((entry) => entry.id === "fal")?.model;
	const contract = videoFormContract(provider, falModel);
	const form = normalizeVideoForm(provider, { prompt: data.prompt, duration_seconds: data.duration_seconds, aspect: data.aspect, ...data.formValues }, falModel);
	const update = (key, value) => data.onChange?.(id, { [key]: value, formValues: normalizeVideoForm(provider, { ...form, [key]: value }, falModel) });
	const changeProvider = (next) => data.onChange?.(id, { provider: next, formValues: normalizeVideoForm(next, { ...form, provider: next }, falModel) });
	return <NodeShell id={id} type="video" title="Video" icon={FiVideo}>
		<label>Model</label><ModelSelect id={id} data={data} category="video" fallback={["video-passthrough", "video-generation"]} />
		{generated && <>
			<label>Provider</label><select value={provider} onChange={(event) => changeProvider(event.target.value)}>{(providers.length ? providers : [{ id: "comfy", name: "ComfyUI", configured: false }, { id: "fal", name: "Fal.ai", configured: false }]).map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.configured}>{entry.name} {!entry.configured ? `(set ${entry.id === "comfy" ? "COZYCLAY_COMFY_URL" : "FAL_KEY"})` : ""}</option>)}</select>
			{provider === "fal" && <div className="workflow-hint">{contract.name} · {providers.find((entry) => entry.id === "fal")?.resolution || contract.defaultResolution}{contract.cameraLocked ? " · locked camera · character motion only" : ""}</div>}
			<label>Motion prompt</label><textarea className="workflow-textarea" value={form.prompt ?? data.prompt ?? ""} onChange={(event) => update("prompt", event.target.value)} placeholder="Motion prompt" />
			<label>Duration (seconds)</label><input type="number" min={contract.minDuration} max={contract.maxDuration} value={form.duration_seconds} onChange={(event) => update("duration_seconds", Number(event.target.value))} />
			<label>Aspect</label>{contract.aspectFromImage ? <><div className="workflow-hint" data-testid="video-source-aspect">Matches input image · frame the full body in the source image</div><div className="workflow-warning" role="status" data-testid="mocap-framing-warning">Before generating: confirm the captured frame shows the head, hands, feet, and any needed objects. Cropped parts can break mocap alignment.</div></> : <select value={form.aspect} onChange={(event) => update("aspect", event.target.value)}>{contract.aspects.map((aspect) => <option key={aspect}>{aspect}</option>)}</select>}
		</>}
		{data.videoUrl && <video controls className="workflow-video-preview" src={data.videoUrl} />}
		{generated && data.preservation?.pass && <div className="workflow-hint workflow-preservation-ok" data-testid="h3-preservation-receipt">✓ H3 scene/camera lock verified{h3VerificationMetrics(data.preservation)}</div>}
		{generated && data.preservation && !data.preservation.pass && <div className="workflow-error workflow-preservation-failed" data-testid="h3-preservation-failed">✕ H3 output rejected: background/camera drift{h3VerificationMetrics(data.preservation)}</div>}
		{generated && data.isLoading && <div className="workflow-hint">Generating video…</div>}{generated && data.errorMsg && <div className="workflow-error">{data.errorMsg}</div>}
		{!generated && <SchemaFields id={id} data={data} category="video" />}
		<div className="workflow-node-foot"><span>Video output <NodeCost data={data} /></span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.(id)} disabled={data.isLoading}><FiPlay size={12} /></button></div>
	</NodeShell>;
}

function AudioNode({ id, data }) {
	return <NodeShell id={id} type="audio" title="Audio" icon={FiMusic}><label>Model</label><ModelSelect id={id} data={data} category="audio" fallback={["audio-passthrough"]} /><label>Prompt</label><input value={data.prompt || ""} onChange={(event) => data.onChange?.(id, { prompt: event.target.value })} placeholder="Describe the voice or music" /><label>Audio URL</label><input value={data.audio_url || ""} onChange={(event) => data.onChange?.(id, { audio_url: event.target.value })} placeholder="https://…" /><SchemaFields id={id} data={data} category="audio" /><div className="workflow-node-foot"><span>Audio output <NodeCost data={data} /></span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.(id)}><FiPlay size={12} /></button></div></NodeShell>;
}

function ApiNode({ id, data }) {
	return <NodeShell id={id} type="api" title="API Node" icon={FiCode}><label>Model</label><ModelSelect id={id} data={data} category="api" fallback={[data.model || "api-model"]} /><label>Parameters (JSON)</label><textarea className="workflow-textarea" value={data.params || "{}"} onChange={(event) => data.onChange?.(id, { params: event.target.value })} /><SchemaFields id={id} data={data} category="api" exclude={["params"]} /><div className="workflow-node-foot"><span>API model <NodeCost data={data} /></span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.(id)}><FiPlay size={12} /></button></div></NodeShell>;
}

function MotionInputNode({ id, data }) {
	const options = Array.isArray(data.characterOptions) ? data.characterOptions : [];
	const normalized = normalizeMotionInputData(data);
	const update = (patch) => data.onChange?.(id, patch);
	const handleId = characterHandleId(normalized.characterId);
	return <NodeShell id={id} type="motion-input" title="Motion Input" icon={FiActivity}>
		<label>Character handle</label>
		<select aria-label="Motion character" value={normalized.characterId} onChange={(event) => update({ characterId: event.target.value })}>
			<option value="">Choose character…</option>
			{options.map((character) => <option key={character.id} value={character.id}>{character.name || characterName(character)}</option>)}
		</select>
		<input aria-label="Character id" value={normalized.characterId} onChange={(event) => update({ characterId: event.target.value.trim() })} placeholder="character id (e.g. char-a)" />
		<label>Motion spec (cozyclay.motion-spec.v1)</label>
		<label className="workflow-upload workflow-motion-upload"><FiUpload size={18} /><span>{normalized.fileName || "Choose a motion spec .json"}</span><input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; file.text().then((body) => { const spec = parseMotionSpec(body); if (!spec) toast.error("Not a cozyclay.motion-spec.v1 file"); update(spec ? { spec, fileName: file.name, status: "ready" } : { spec: null, fileName: file.name, status: "error" }); }); }} /></label>
		<div className="workflow-node-foot"><span>{normalized.status === "ready" ? `${handleId} ready` : "Connect to a character handle"}</span><span>{motionInputOutput(normalized).frames ? `${motionInputOutput(normalized).frames}f` : ""}</span></div>
	</NodeShell>;
}

function VideoCombinerNode({ id, data }) {
	return <NodeShell id={id} type="video-combiner" title="Video Combiner" icon={FiFilm}><label>Model</label><ModelSelect id={id} data={data} category="utility" allowedModels={["video-combiner"]} fallback={["video-combiner"]} /><label>Video URLs (one per line)</label><textarea className="workflow-textarea" value={(data.videos_list || []).join("\n")} onChange={(event) => data.onChange?.(id, { videos_list: event.target.value.split(/\n+/).map((value) => value.trim()).filter(Boolean) })} placeholder="https://…" /><label>Aspect ratio</label><select value={data.aspect_ratio || "auto"} onChange={(event) => data.onChange?.(id, { aspect_ratio: event.target.value })}><option>auto</option><option>16:9</option><option>9:16</option><option>1:1</option></select><SchemaFields id={id} data={data} category="utility" exclude={["videos_list", "aspect_ratio"]} /><div className="workflow-node-foot"><span>Combined video <NodeCost data={data} /></span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.(id)}><FiPlay size={12} /></button></div></NodeShell>;
}

function UploadNode({ id, data }) {
	return <NodeShell id={id} type="upload" title="Upload" icon={FiUpload}><label className="workflow-upload"><FiUpload size={18} /><span>{data.uploading ? "Reading…" : "Choose image, video, or audio"}</span><input type="file" accept="image/*,video/*,audio/*" disabled={data.uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) data.onUpload?.(id, file); }} /></label>{typeof data.image_url === "string" && data.image_url.startsWith("data:image/") && <img className="workflow-image-preview" src={data.image_url} alt={data.fileName || "Uploaded image"} />}<p className="workflow-hint">{data.fileName || "Files stay local to this browser session. Paste or drop an image onto the canvas to add one here."}</p></NodeShell>;
}

function ConcatNode({ id, data }) {
	return <NodeShell id={id} type="concat" title="Prompt Concat" icon={FiLink}><label>Template</label><input value={data.template || "{prompt} {style}"} onChange={(event) => data.onChange?.(id, { template: event.target.value })} /><div className="workflow-node-foot"><span>Text merge</span></div><Handle type="target" position={Position.Left} id="input-a" className="workflow-handle target" /></NodeShell>;
}

// ShotPromptNode lives in its own file and takes NodeShell by injection, so it
// never has to import back into this module.
function ShotPromptNodeType(props) {
	return <ShotPromptNode {...props} NodeShell={NodeShell} />;
}

const NODE_TYPES = { text: TextNode, image: ImageNode, video: VideoNode, audio: AudioNode, api: ApiNode, "video-combiner": VideoCombinerNode, upload: UploadNode, concat: ConcatNode, "motion-input": MotionInputNode, "shot-prompt": ShotPromptNodeType };

function SceneNodeType({ data, ...props }) {
	return <CozySceneNode {...props} data={data} HandleComponent={Handle} onDataChange={data.onSceneChange} onRun={data.onSceneRun} onVideo={data.onSceneVideo} onOpenScene={() => window.open("/app/", "_blank", "noopener,noreferrer")} />;
}

const FLOW_NODE_TYPES = { ...NODE_TYPES, scene: SceneNodeType };

export default function WorkflowBuilder() {
	const initial = useMemo(readGraph, []);
	const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
	const [locked, setLocked] = useState(false);
	const [runState, setRunState] = useState("local");
	const [lastSaved, setLastSaved] = useState(false);
	const [nodeSchemas, setNodeSchemas] = useState(() => globalThis.__COZYCLAY_NODE_SCHEMAS__ || DEFAULT_NODE_SCHEMAS);
	const [modelSearch, setModelSearch] = useState("");
	const [sceneCharacters, setSceneCharacters] = useState(() => activeSceneCharacters());
	const [sceneContext, setSceneContext] = useState(() => { const doc = readStoredSceneDocument(); const scene = doc?.scenes?.find((entry) => entry?.id === doc?.activeSceneId) ?? doc?.scenes?.[0]; return { id: scene?.id || null, name: scene?.name || "CozyClay Scene" }; });
	const graph = useMemo(() => serializableGraph(nodes, edges), [nodes, edges]);
	const graphRef = useRef(graph);
	const commandsRef = useRef(null);
	useEffect(() => { graphRef.current = graph; }, [graph]);

	const updateNode = useCallback((id, patch) => setNodes((current) => current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)), [setNodes]);
	const updateScene = useCallback(({ id, patch }) => setNodes((current) => current.map((node) => {
		if (node.id !== id) return node;
		// The patch is applied here, against the node's freshest data, rather than
		// stored as the envelope the caller normalized: the Scene node ticks its
		// preview clock at 24fps from a render-old snapshot, and writing that whole
		// snapshot threw away anything that landed in between — the take length the
		// embed announces, for one (#218). Nested control/camera patches still
		// merge, which is why the envelope was passed in the first place; keys the
		// Scene envelope does not know (outputs, resultUrl) ride through untouched.
		return { ...node, data: { ...node.data, ...patch, ...applyCozyScenePatch(node.data, patch) } };
	})), [setNodes]);
	const flowRef = useRef(null);
	const addNode = useCallback((type, model = null, { position: at, data } = {}) => {
		const id = `${type}-${Date.now()}`;
		setNodes((current) => {
			const extraIndex = Math.max(0, current.length - 3);
			const position = at ?? (current.length < 3
				? { x: 80 + current.length * 300, y: 100 }
				: { x: 80 + (extraIndex % 2) * 360, y: 560 + Math.floor(extraIndex / 2) * 260 });
			const node = makeNode(type, id, position, model, nodeSchemas);
			return [...current, data ? { ...node, data: { ...node.data, ...data } } : node];
		});
		toast.success(`${type === "scene" ? "CozyClay Scene" : type} node added`);
		return id;
	}, [nodeSchemas, setNodes]);
	// An image pasted or dropped onto the canvas becomes an Upload node holding
	// a data URL, so it survives reload and can feed the Image node's reference.
	const canvasRef = useRef(null);
	const placeImage = useCallback(async (file, screen) => {
		const dataUrl = await fileToDataUrl(file);
		const instance = flowRef.current;
		const bounds = canvasRef.current?.getBoundingClientRect();
		const point = screen ?? (bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : null);
		const position = instance && point ? instance.screenToFlowPosition(point) : undefined;
		addNode("upload", null, { position, data: pastedImageNodeData(file, dataUrl) });
	}, [addNode]);
	useEffect(() => {
		const onPaste = (event) => {
			// The Agent composer holds pasted pictures itself now (#367). One gesture
			// is one result: a paste it has already claimed never also lands a node.
			if (event.defaultPrevented) return;
			if (!canvasTakesPaste(event.target, event.clipboardData)) return;
			const file = imageFileFromTransfer(event.clipboardData);
			event.preventDefault();
			placeImage(file).catch((error) => toast.error(`Could not paste the image (${error.message})`));
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, [placeImage]);
	const onCanvasDragOver = useCallback((event) => { if (imageFileFromTransfer(event.dataTransfer) || Array.from(event.dataTransfer?.types ?? []).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }, []);
	const onCanvasDrop = useCallback((event) => {
		const file = imageFileFromTransfer(event.dataTransfer);
		if (!file) return;
		event.preventDefault();
		placeImage(file, { x: event.clientX, y: event.clientY }).catch((error) => toast.error(`Could not add the image (${error.message})`));
	}, [placeImage]);
	const changeModel = useCallback((id, type, model) => {
		const category = schemaCategoryForType(type);
		const properties = schemaProperties(nodeSchemas, category, model.id);
		updateNode(id, { model: model.id, selectedModel: model, formValues: defaultFormValues(properties) });
	}, [nodeSchemas, updateNode]);
	// "Use as reference" branches off a version: the picked take becomes an
	// Upload node (a data URL, like a pasted image) feeding a fresh Image node,
	// so the next round of generations starts from that frame.
	const useVersionAsReference = useCallback((id, index) => {
		const node = nodes.find((entry) => entry.id === id);
		const { versions, index: current } = versionState(node?.data);
		const position = Number.isInteger(index) ? Math.min(Math.max(index, 0), versions.length - 1) : current;
		const version = versions[position];
		if (!version?.dataUrl) { toast.error("Generate an image before using it as a reference"); return; }
		const origin = node.position || { x: 0, y: 0 };
		const name = `version-${position + 1}.png`;
		const file = { name, type: version.dataUrl.slice(5, version.dataUrl.indexOf(";")) || "image/png" };
		const uploadId = addNode("upload", null, {
			position: { x: origin.x + 320, y: origin.y },
			data: { ...pastedImageNodeData(file, version.dataUrl), uploadName: name, thumbnail: version.dataUrl, label: "Upload" },
		});
		const imageId = addNode("image", { id: "image-generation", name: "Image generation" }, {
			position: { x: origin.x + 640, y: origin.y },
			data: { prompt: version.prompt || "" },
		});
		setEdges((currentEdges) => addEdge({ id: `e-${uploadId}-${imageId}`, source: uploadId, target: imageId, sourceHandle: "output", targetHandle: "input", animated: true, style: { stroke: "#8994ff", strokeWidth: 2 } }, currentEdges));
		toast.success(`v${position + 1} reused as a reference`);
	}, [addNode, nodes, setEdges]);
	useEffect(() => {
		// A host app can inject the same schema envelope fetched by Vibe's
		// /api/workflow/:id/node-schemas endpoint. Keep the local defaults if it
		// is unavailable so editing remains offline-first.
		const injected = globalThis.__COZYCLAY_NODE_SCHEMAS__;
		if (injected?.categories) setNodeSchemas(injected);
	}, []);
	useEffect(() => {
		const refreshCharacters = () => {
			const nextCharacters = activeSceneCharacters();
			const doc = readStoredSceneDocument();
			const scene = doc?.scenes?.find((entry) => entry?.id === doc?.activeSceneId) ?? doc?.scenes?.[0];
			setSceneCharacters(nextCharacters);
			setSceneContext({ id: scene?.id || null, name: scene?.name || "CozyClay Scene" });
		};
		window.addEventListener("storage", refreshCharacters);
		window.addEventListener("cozyclay:scene-change", refreshCharacters);
		return () => { window.removeEventListener("storage", refreshCharacters); window.removeEventListener("cozyclay:scene-change", refreshCharacters); };
	}, []);
	useEffect(() => { storeWorkflowGraph(graph); }, [graph]);
	useEffect(() => {
		const onStorage = (event) => {
			if (event.key !== WORKFLOW_STORAGE_KEY) return;
			const next = loadWorkflowGraph();
			// An explicit empty graph is a real new-project state. Only a removed
			// key means there is no draft and should restore the starter nodes.
			setNodes(event.newValue === null ? DEFAULT_GRAPH.nodes : next.nodes);
			setEdges(event.newValue === null ? DEFAULT_GRAPH.edges : next.edges);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [setEdges, setNodes]);
	useEffect(() => {
		const connected = (handle) => edges.filter((edge) => edge.targetHandle === handle).map((edge) => edge.source).filter((source, index, values) => values.indexOf(source) === index);
		const assetInputs = connected("asset");
		const motionInputs = edges.filter((edge) => edge.targetHandle === "motion" || characterIdFromHandle(edge.targetHandle)).map((edge) => edge.source).filter((source, index, values) => values.indexOf(source) === index);
		const characterInputs = edges.filter((edge) => characterIdFromHandle(edge.targetHandle)).map((edge) => ({ source: edge.source, characterId: characterIdFromHandle(edge.targetHandle), handle: edge.targetHandle })).filter((entry) => entry.characterId);
		setNodes((current) => {
			let changed = false;
			const next = current.map((node) => {
				if (node.type !== "scene") return node;
				const oldAssets = Array.isArray(node.data?.assetInputs) ? node.data.assetInputs : [];
				const oldMotion = Array.isArray(node.data?.motionInputs) ? node.data.motionInputs : [];
				const oldCharacters = Array.isArray(node.data?.characterInputs) ? node.data.characterInputs : [];
				if (JSON.stringify(oldAssets) === JSON.stringify(assetInputs) && JSON.stringify(oldMotion) === JSON.stringify(motionInputs) && JSON.stringify(oldCharacters) === JSON.stringify(characterInputs)) return node;
				changed = true;
				return { ...node, data: { ...node.data, assetInputs, motionInputs, characterInputs } };
			});
			return changed ? next : current;
		});
	}, [edges, setNodes]);

	const uploadFile = useCallback(async (id, file) => {
		updateNode(id, { uploading: true, fileName: file.name });
		const kind = file.type.startsWith("video/") ? "video_url" : file.type.startsWith("audio/") ? "audio_url" : "image_url";
		const localUrl = kind === "image_url" ? await fileToDataUrl(file) : URL.createObjectURL(file);
		try {
			if (kind === "image_url") {
				const imported = await importImageIntoActiveScene(file);
				updateNode(id, { uploading: false, fileName: file.name, mimeType: file.type, fileUrl: localUrl, localPreview: true, [kind]: localUrl, assetId: imported.asset.id, outputs: [{ value: localUrl }] });
				toast.success(imported.changed ? "Image added to the active Scene" : "Image already exists in the active Scene");
				return;
			}
		} catch (error) {
			toast(`Scene import unavailable; local preview kept (${error.message})`);
		}
		updateNode(id, { uploading: false, fileName: file.name, mimeType: file.type, fileUrl: localUrl, localPreview: true, [kind]: localUrl, outputs: [{ value: localUrl }] });
		toast.success("File kept in this browser session");
	}, [updateNode]);
	const saveWorkflow = useCallback(() => {
		storeWorkflowGraph(graph);
		setLastSaved(true);
		toast.success("Workflow saved locally");
	}, [graph]);

	const runWorkflowRef = useRef(null);
	const runWorkflow = useCallback(async (nodeId = null, input = graph) => {
		const execution = startWorkflowExecution(
			{ node_count_bucket: bucketCount(input.nodes.length) },
			{ capture: track, durationBucket: bucketMs },
		);
		try {
			if (!input.nodes.length) {
				setRunState("complete");
				execution.succeed();
				toast.success("Local CozyClay scene is ready");
				return { graph: input, outputs: [] };
			}
			setRunState("running");
			const graph = input;
			const result = executeLocalWorkflowGraph(graph, { runId: `local-${Date.now()}` });
			setNodes(result.nodes);
			const values = new Map();
			const sceneMeta = new Map();
			// Everything runWorkflow writes to a node also lands in the graph it
			// returns, so a caller that republishes that graph keeps the results.
			const patches = new Map();
			// This run's captured references per Scene node, for the Image nodes fed
			// by it — same precedence as sceneMeta: a fresh capture wins.
			const sceneReferences = new Map();
			let runFailure = null;
			const patchNode = (id, patch) => { patches.set(id, { ...(patches.get(id) || {}), ...patch }); updateNode(id, patch); };
			for (const id of result.order) {
				const current = result.nodes.find((node) => node.id === id);
				if (!current) continue;
				if (current.type === "scene") {
					try {
						const frame = await captureSceneFrame(id);
						values.set(id, frame.dataUrl);
						// The capture metadata rides along on lastOutput so a downstream
						// Shot Prompt node can describe the shot without re-capturing, and
						// the identity/environment references (#167) ride with it so an
						// Image node downstream can attach them.
						const references = Array.isArray(frame.references) ? frame.references : [];
						patchNode(id, { status: "complete", statusMessage: "Captured framing PNG", preview: "render", lastOutput: { renderUrl: frame.dataUrl, sceneUrl: "/app/", jobId: null, meta: frame.meta ?? null, references }, outputs: [{ value: frame.dataUrl }], resultUrl: frame.dataUrl });
						execution.apply();
						sceneMeta.set(id, frame.meta ?? current.data?.lastOutput?.meta ?? null);
						sceneReferences.set(id, references);
					} catch (error) {
						runFailure ||= { error, code: "capture_failed" };
						patchNode(id, { status: "error", errorMsg: error.message, statusMessage: error.message });
					}
				} else if (current.type === "shot-prompt") {
					const incoming = (graph.edges || []).filter((edge) => edge.target === id).map((edge) => result.nodes.find((node) => node.id === edge.source)).filter(Boolean);
					const scene = incoming.find((node) => node.type === "scene");
					// This run's capture wins; the stored one keeps the node useful when
					// the Scene was captured in an earlier run.
					const meta = (scene && sceneMeta.get(scene.id)) || scene?.data?.lastOutput?.meta || null;
					const intent = incoming.filter((node) => node.type === "text").map((node) => node.data?.prompt ?? values.get(node.id)).find((value) => typeof value === "string" && value.trim());
					const { prompt, error } = shotPromptFromInputs({ meta, intent, target: current.data?.target, referenceOwnsCamera: current.data?.referenceOwnsCamera });
					if (error) {
						runFailure ||= { code: "unknown" };
						patchNode(id, { status: "error", errorMsg: error, prompt: "", outputs: [], resultUrl: null });
						continue;
					}
					values.set(id, prompt);
					patchNode(id, { status: "complete", errorMsg: null, prompt, outputs: [{ value: prompt }], resultUrl: null });
				} else if (current.type === "video" && current.data?.model === "video-generation") {
					const incoming = (graph.edges || []).filter((edge) => edge.target === id).map((edge) => ({ edge, value: values.get(edge.source), node: result.nodes.find((node) => node.id === edge.source) }));
					const imageInputs = incoming.filter((entry) => typeof entry.value === "string" && entry.value.startsWith("data:image/"));
					const frame = imageInputs[0]?.value;
					const lastFrameDataUrl = imageInputs[1]?.value;
					if (!frame) { runFailure ||= { code: "unknown" }; patchNode(id, { status: "error", errorMsg: "Connect a Scene frame or an image before generating." }); continue; }
					const form = current.data.formValues || {};
					// A Shot Prompt node upstream is an explicit prompt: it wins over an
					// empty motion prompt on the node itself.
					const upstreamPrompt = incoming.map((entry) => entry.node?.type === "shot-prompt" ? entry.value : null).find((value) => typeof value === "string" && value.trim());
					const motionPrompt = String(form.prompt ?? current.data.prompt ?? "").trim() || upstreamPrompt || "";
					// Remove the previous take while a new one is being verified. Keeping it
					// visible during a failed H3 run makes an old, valid clip look like the
					// newly requested result.
					values.delete(id);
					patchNode(id, { isLoading: true, status: "running", errorMsg: null, videoUrl: null, resultUrl: null, outputs: [], preservation: null });
					try {
						const provider = form.provider || current.data.provider || "comfy";
						const falModel = provider === "fal" ? (await createHttpTransport().videoProviders()).providers?.find((entry) => entry.id === "fal")?.model : undefined;
						const videoForm = normalizeVideoForm(provider, { ...form, duration_seconds: form.duration_seconds ?? current.data.duration_seconds, aspect: form.aspect || current.data.aspect }, falModel);
						const output = await createHttpTransport().video({ provider, prompt: motionPrompt, imageDataUrl: frame, ...(lastFrameDataUrl ? { lastFrameDataUrl } : {}), durationSeconds: videoForm.duration_seconds, aspect: videoForm.aspect });
						const videoUrl = output.dataUrl || output.url;
						values.set(id, videoUrl);
						patchNode(id, { isLoading: false, status: "complete", videoUrl, resultUrl: videoUrl, outputs: [{ value: videoUrl }], preservation: output.preservation || null, errorMsg: null });
						if (videoUrl) execution.apply();
					}
					catch (error) {
						runFailure ||= { error, code: "generation_failed" };
						values.delete(id);
						patchNode(id, { isLoading: false, status: "error", errorMsg: error.message, statusMessage: error.message, videoUrl: null, resultUrl: null, outputs: [], preservation: error?.preservation || null });
					}
				} else if (current.type === "image" && current.data?.model === "image-generation") {
					const incoming = (graph.edges || []).filter((edge) => edge.target === id).map((edge) => ({ edge, value: values.get(edge.source), node: result.nodes.find((node) => node.id === edge.source) }));
					const frame = incoming.find((entry) => entry.node?.type === "scene" && entry.value)?.value;
					const upstreamReference = incoming.find((entry) => entry.node?.type !== "scene" && typeof entry.value === "string" && entry.value.startsWith("data:image/"))?.value;
					const upstreamSource = frame || incoming.map((entry) => entry.value).find(Boolean) || current.data.image_url;
					// Pinned references keep the frame and reference of the shown version,
					// so a prompt tweak is the only thing that changes between takes.
					const { source, reference } = pinnedInputs(current.data, { source: upstreamSource, reference: upstreamReference });
					if (!source) { runFailure ||= { code: "unknown" }; patchNode(id, { status: "error", errorMsg: "Connect a Scene frame before generating." }); continue; }
					// Same precedence as the Video node: the node's own prompt if it has
					// one, otherwise the structured prompt from an upstream Shot Prompt.
					const upstreamPrompt = incoming.map((entry) => entry.node?.type === "shot-prompt" ? entry.value : null).find((value) => typeof value === "string" && value.trim());
					const prompt = String(current.data.prompt || "").trim() || upstreamPrompt || "";
					// Identity sheets and the environment reference come from whichever
					// Scene node feeds this one: this run's capture first, else the one
					// stored on the node from an earlier run.
					const sceneNode = incoming.find((entry) => entry.node?.type === "scene")?.node;
					const references = (sceneNode && sceneReferences.get(sceneNode.id)) || (Array.isArray(sceneNode?.data?.lastOutput?.references) ? sceneNode.data.lastOutput.references : []);
					patchNode(id, { isLoading: true, errorMsg: null });
					try { const output = await createHttpTransport().image({ prompt, imageDataUrl: source, referenceDataUrl: reference || (typeof current.data.image_url === "string" && current.data.image_url.startsWith("data:image/") ? current.data.image_url : undefined), ...(references.length ? { references } : {}), quality: "auto" }); values.set(id, output.dataUrl); patchNode(id, { isLoading: false, status: "complete", errorMsg: null, ...appendVersion(current.data, { dataUrl: output.dataUrl, prompt, referenceDataUrl: reference || null, frameDataUrl: source, at: Date.now() }) }); if (output.dataUrl) execution.apply(); }
					catch (error) {
						runFailure ||= { error, code: "generation_failed" };
						patchNode(id, { isLoading: false, status: "error", errorMsg: error.message });
					}
				} else values.set(id, current.data?.outputs?.[0]?.value);
			}
			const resultById = new Map(result.nodes.map((node) => [node.id, node]));
			for (const scene of result.nodes.filter((node) => node.type === "scene")) {
				for (const assignment of Array.isArray(scene.data?.characterInputs) ? scene.data.characterInputs : []) {
					const source = resultById.get(assignment.source);
					if (source?.type !== "motion-input" || !assignment.characterId) continue;
					const motion = motionInputOutput({ ...source.data, ...(patches.get(source.id) || {}) });
					if (motion.spec) applyMotionToActiveScene(assignment.characterId, motion);
				}
			}
			setRunState("complete");
			toast.success(nodeId ? "Node evaluated locally" : "Workflow evaluated locally");
			const outputs = result.nodes.map((node) => {
				const patch = patches.get(node.id);
				const hasPatchedOutputs = patch && Object.prototype.hasOwnProperty.call(patch, "outputs");
				return { id: node.id, outputs: values.has(node.id) && values.get(node.id) !== undefined ? [{ value: values.get(node.id) }] : hasPatchedOutputs ? patch.outputs : node.data?.outputs || [] };
			});
			const completed = { graph: serializableGraph(result.nodes.map((node) => ({ ...node, data: { ...node.data, ...(patches.get(node.id) || {}), outputs: outputs.find((entry) => entry.id === node.id).outputs } })), graph.edges), outputs };
			if (runFailure) execution.fail(runFailure.error, runFailure.code);
			else execution.succeed();
			return completed;
		} catch (error) {
			execution.fail(error);
			setRunState("complete");
			throw error;
		}
	}, [graph, setNodes]);

	useEffect(() => { runWorkflowRef.current = runWorkflow; }, [runWorkflow]);
	useEffect(() => {
		const store = {
			getGraph: () => graphRef.current,
			setGraph: (next) => { setNodes(next.nodes || []); setEdges(next.edges || []); },
			// The agent's run_workflow is the same run as the Run button: Scene
			// capture and Image generation included, not just the local evaluator.
			run: (input = graphRef.current) => runWorkflowRef.current(null, input),
			focus: (id) => { document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", inline: "center" }); },
		};
		window.__cozyclayWorkflow = store;
		commandsRef.current = createCanvasCommands({ store, makeNode, nodeSchemas });
		const control = createLiveControl({ handlers: commandsRef.current.handlers, meta: { kind: "workflow", commands: Object.keys(commandsRef.current.handlers) } });
		const onKeyDown = (event) => { const target = event.target; const editing = target instanceof HTMLElement && (target.matches("input,textarea,select,[contenteditable=true]") || target.isContentEditable); if (!editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); commandsRef.current.undo(); } };
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			control.close();
			commandsRef.current = null;
			if (window.__cozyclayWorkflow === store) delete window.__cozyclayWorkflow;
		};
	}, [nodeSchemas, setEdges, setNodes]);
	const runScene = useCallback(async ({ id }) => {
		const execution = startWorkflowExecution({ node_count_bucket: "1-3" }, { capture: track, durationBucket: bucketMs });
		updateScene({ id, patch: { status: "running", statusMessage: "Capturing framing PNG" } });
		try { const frame = await captureSceneFrame(id); updateScene({ id, patch: { status: "complete", statusMessage: "Captured framing PNG", preview: "render", lastOutput: { renderUrl: frame.dataUrl, sceneUrl: "/app/", jobId: null, meta: frame.meta ?? null, references: Array.isArray(frame.references) ? frame.references : [] }, outputs: [{ value: frame.dataUrl }], resultUrl: frame.dataUrl } }); execution.apply(); execution.succeed(); toast.success("Scene frame captured"); }
		catch (error) { execution.fail(error, "capture_failed"); updateScene({ id, patch: { status: "error", errorMsg: error.message, statusMessage: error.message } }); }
	}, [updateScene]);
	// The previs is a step, not a destination: this is the one click from the
	// staged shot to the clip it is meant to become, wired render -> input so the
	// next Run hands the captured frame straight to the video model.
	const sendSceneToVideo = useCallback(({ id }) => {
		const scene = nodes.find((entry) => entry.id === id);
		const origin = scene?.position || { x: 0, y: 0 };
		const videoId = addNode("video", { id: "video-generation", name: "Video generation" }, { position: { x: origin.x + 380, y: origin.y } });
		setEdges((current) => addEdge({ id: `e-${id}-${videoId}`, source: id, target: videoId, sourceHandle: "render", targetHandle: "input", animated: true, style: { stroke: "#8994ff", strokeWidth: 2 } }, current));
		toast.success("Video node connected to the Scene render");
	}, [addNode, nodes, setEdges]);

	const decoratedNodes = useMemo(() => nodes.map((node) => ({
		...node,
		data: {
			...node.data,
			id: node.id,
			nodeSchemas,
			characterOptions: sceneCharacters,
			...(node.type === "scene" ? { characters: sceneCharacters, sceneId: sceneContext.id, sceneName: sceneContext.name } : {}),
			onChange: updateNode,
			onModelChange: changeModel,
			...(node.type === "scene" ? { onSceneChange: updateScene, onSceneRun: runScene, onSceneVideo: sendSceneToVideo } : { onRun: runWorkflow }),
			...(node.type === "upload" ? { onUpload: uploadFile } : {}),
			...(node.type === "image" ? { onUseAsReference: useVersionAsReference } : {}),
		},
	})), [changeModel, nodeSchemas, nodes, runScene, runWorkflow, sceneCharacters, sceneContext, sendSceneToVideo, updateNode, updateScene, uploadFile, useVersionAsReference]);

	const exportGraph = useCallback(async () => { const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" }); await saveExport(blob, "cozyclay-workflow.json"); toast.success("Workflow exported"); }, [graph]);
	const onConnect = useCallback((params) => {
		const target = nodes.find((node) => node.id === params.target);
		const source = nodes.find((node) => node.id === params.source);
		if (target?.type === "motion-input") {
			toast.error("Motion Input takes a motion spec file, not a node");
			return;
		}
		if (target?.type === "scene" && !sceneConnectionAllowed(source, params.targetHandle, source?.data)) {
			toast.error((params.targetHandle || "").startsWith("character:") || params.targetHandle === "motion" ? "Character inputs accept Motion Input only" : "Scene asset input accepts images only");
			return;
		}
		setEdges((current) => addEdge({ ...params, animated: true, style: { stroke: "#8994ff", strokeWidth: 2 } }, current));
	}, [nodes, setEdges]);
	const runLabel = { local: "Local workflow", running: "Running", complete: "Complete" }[runState] || "Local workflow";
	const modelOptions = useMemo(() => ["text", "image", "video", "audio", "api"].flatMap((type) => schemaModelEntries(nodeSchemas, type).map((model) => ({ ...model, type }))).filter((model) => !modelSearch.trim() || `${model.name} ${model.id}`.toLowerCase().includes(modelSearch.trim().toLowerCase())).slice(0, 8), [modelSearch, nodeSchemas]);
	const modelIcons = { text: FiType, image: FiImage, video: FiVideo, audio: FiMusic, api: FiCode };

	return <div className="workflow-app">
		<Toaster position="bottom-right" toastOptions={{ style: { background: "#252833", color: "#f4f5fb" } }} />
		<header className="workflow-topbar"><div className="workflow-brand"><span className="workflow-brand-mark">C</span><span>CozyClay</span><span className="workflow-divider">/</span><strong>Workflow</strong></div><div className="workflow-top-actions"><span className={`workflow-status ${runState}`}><i /> {runLabel}</span><button type="button" onClick={saveWorkflow}>{lastSaved ? "Saved" : "Save"}</button><button type="button" onClick={() => runWorkflow()}><FiPlay size={12} /> Run</button><button type="button" onClick={exportGraph}>Export</button><button type="button" className="workflow-agent-toggle" title="Toggle agent panel (Cmd/Ctrl+B)" onClick={() => window.dispatchEvent(new CustomEvent("cozyclay:agent-panel-toggle"))}>Agent</button></div></header>
		<div className="workflow-main"><aside className="workflow-sidebar"><div className="workflow-sidebar-title">Nodes</div><p className="workflow-sidebar-copy">Build a visual chain from prompts to a staged CozyClay scene.</p><input className="workflow-node-search" aria-label="Search nodes or models" placeholder="Search nodes or models" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} />{modelSearch && <div className="workflow-model-results">{modelOptions.length ? modelOptions.map((model) => { const Icon = modelIcons[model.type] || FiBox; return <button type="button" key={`${model.type}-${model.id}`} className="workflow-add-node" onClick={() => { addNode(model.type, model); setModelSearch(""); }}><span style={{ color: NODE_COLORS[model.type] }}><Icon size={15} /></span><span>{model.name}</span><FiPlus size={13} /></button>; }) : <span className="workflow-hint">No models found</span>}</div>}<div className="workflow-node-menu">{[["text", "Text", FiType], ["image", "Image", FiImage], ["video", "Video", FiVideo], ["audio", "Audio", FiMusic], ["api", "API Node", FiCode], ["video-combiner", "Video Combiner", FiFilm], ["motion-input", "Motion Input", FiActivity], ["shot-prompt", "Shot Prompt", FiFileText], ["upload", "Upload", FiUpload], ["concat", "Prompt Concat", FiLink], ["scene", "CozyClay Scene", FiBox]].map(([type, label, Icon]) => <button type="button" key={type} className="workflow-add-node" onClick={() => addNode(type)}><span style={{ color: NODE_COLORS[type] }}><Icon size={16} /></span><span>{label}</span><FiPlus size={13} /></button>)}</div><div className="workflow-sidebar-bottom"><button type="button" onClick={() => setLocked((value) => !value)}>{locked ? "Unlock canvas" : "Lock canvas"}</button><a href="/app/">Open Studio ↗</a></div></aside><section className="workflow-canvas" ref={canvasRef} onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}><ReactFlow onInit={(instance) => { flowRef.current = instance; }} nodes={decoratedNodes} edges={edges} nodeTypes={FLOW_NODE_TYPES} onNodesChange={locked ? undefined : onNodesChange} onEdgesChange={locked ? undefined : onEdgesChange} onConnect={locked ? undefined : onConnect} fitView snapToGrid snapGrid={[16, 16]} defaultEdgeOptions={{ type: "smoothstep" }}><Background color="#282c38" gap={24} size={1} /><Controls showInteractive={false} /><Panel position="top-right" className="workflow-canvas-panel"><button type="button" onClick={() => addNode("scene")}><FiPlus size={13} /> Add node</button></Panel></ReactFlow></section><AgentPanel sceneName={sceneContext.name} /></div>
	</div>;
}
