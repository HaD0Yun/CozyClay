import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONTROLLER_PEERS_CAPABILITY,
	DIRECTOR_STREAM_CAPABILITY,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseClientMessage,
	parseDaemonBridgeMessage,
	parseDirectorTranscript,
	parseDirectorTranscriptRequest,
	parseDirectorTurnDelta,
	parseDirectorTurnEvent,
	parseHelloAck,
	parseServerMessage,
	SNAPSHOT_CURSOR_V2_FEATURE,
	TRANSACTION_COMMIT_CAPABILITY,
} from "../src/messages.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000003";
const PROJECT_ID = "00000000-0000-4000-8000-000000000004";
const SEGMENT_ID = "00000000-0000-4000-8000-000000000005";
const LINEAGE_ID = "00000000-0000-4000-8000-000000000006";
const LAUNCH_ID = "00000000-0000-4000-8000-000000000007";
const SESSION_ID = "00000000-0000-4000-8000-000000000008";
const HASH = "a".repeat(64);
const AT = "2026-07-20T00:00:00.000Z";
const MUTATION_CAPABILITY = "mutation_bridge_v2";
const STAGE_CAPABILITY = "scene_manifest_v3";

const delta = {
	type: "director_turn_delta",
	id: ID,
	segment_id: SEGMENT_ID,
	content_index: 0,
	delta_sequence: 0,
	delta: "x",
} as const;
const utterance = {
	type: "director_assistant_utterance",
	id: ID,
	sequence: 1,
	at: AT,
	segment_id: SEGMENT_ID,
	content_index: 0,
	through_delta_sequence: 0,
	content: "complete text",
} as const;

const bridgePublication = { type: "publish_bridge_discovery_slot", id: ID } as const;
const bridgePublicationAck = {
	type: "bridge_discovery_slot_ack",
	id: ID,
	generation: 1,
	expires_in_ms: 15_000,
} as const;
const peerPublication = {
	type: "publish_controller_peer_discovery_slot",
	id: ID,
	lineage_id: LINEAGE_ID,
} as const;
const peerPublicationAck = {
	type: "controller_peer_discovery_slot_ack",
	id: ID,
	lineage_id: LINEAGE_ID,
	generation: 2_147_483_647,
	expires_in_ms: 15_000,
} as const;

const prepared = {
	type: "bridge_transaction_prepared",
	id: REQUEST_ID,
	transaction_id: TRANSACTION_ID,
	operation: "stage_scene",
	project_id: PROJECT_ID,
	base_revision_id: HASH,
	base_scene_hash: HASH,
	candidate_revision_id: HASH,
	candidate_scene_hash: HASH,
	base_backup_sha256: HASH,
	canonical_blend_sha256: HASH,
} as const;
const ack = {
	type: "bridge_transaction_ack",
	id: REQUEST_ID,
	transaction_id: TRANSACTION_ID,
	status: "committed",
	resulting_revision_id: HASH,
} as const;
const acknowledged = {
	type: "bridge_transaction_acknowledged",
	id: REQUEST_ID,
	transaction_id: TRANSACTION_ID,
} as const;
const reconcile = {
	type: "bridge_transaction_reconcile",
	id: REQUEST_ID,
	project_id: PROJECT_ID,
	transaction_id: TRANSACTION_ID,
	marker_phase: "prepared",
} as const;
const status = {
	type: "bridge_transaction_status",
	id: REQUEST_ID,
	transaction_id: TRANSACTION_ID,
	status: "base_authoritative",
	revision_id: HASH,
} as const;
const transactionError = {
	type: "bridge_transaction_error",
	id: REQUEST_ID,
	transaction_id: TRANSACTION_ID,
	code: "TRANSACTION_CONFLICT",
	message: "transaction id was reused with different content",
	retryable: false,
} as const;

function transactionSession() {
	return negotiateMutationBridge(
		{
			type: "hello",
			protocol: 2,
			addon_version: "0.1.0",
			blender_version: "4.5.0",
			project_id: PROJECT_ID,
			client_nonce: "AAAAAAAAAAAAAAAAAAAAAA",
			capabilities: [MUTATION_CAPABILITY, STAGE_CAPABILITY, TRANSACTION_COMMIT_CAPABILITY],
		},
		{
			type: "hello_ack",
			protocol: 2,
			daemon_version: "0.1.0",
			launch_id: LAUNCH_ID,
			session_id: SESSION_ID,
			server_nonce: "BBBBBBBBBBBBBBBBBBBBBB",
			capabilities: [MUTATION_CAPABILITY, STAGE_CAPABILITY, TRANSACTION_COMMIT_CAPABILITY],
		},
	);
}

describe("CCLAY conversational surface protocol", () => {
	it("freezes controller and transaction capability names", () => {
		assert.equal(DIRECTOR_STREAM_CAPABILITY, "director_stream_v1");
		assert.equal(CONTROLLER_PEERS_CAPABILITY, "controller_peers_v1");
		assert.equal(TRANSACTION_COMMIT_CAPABILITY, "transaction_commit_v2");
		assert.equal(SNAPSHOT_CURSOR_V2_FEATURE, "snapshot_cursor_v2");
	});

	it("accepts exact bounded stream deltas and rejects extra or oversized data", () => {
		assert.deepEqual(parseDirectorTurnDelta(delta), delta);
		assert.deepEqual(parseServerMessage({ ...delta, content_index: 31, delta_sequence: 1_000_000 }), {
			...delta,
			content_index: 31,
			delta_sequence: 1_000_000,
		});
		assert.equal(parseDirectorTurnDelta({ ...delta, delta: "🙂".repeat(1_024) }).delta.length, 2_048);
		for (const invalid of [
			{ ...delta, delta: "" },
			{ ...delta, delta: "x".repeat(4_097) },
			{ ...delta, delta: `${"🙂".repeat(1_024)}x` },
			{ ...delta, content_index: -1 },
			{ ...delta, content_index: 32 },
			{ ...delta, delta_sequence: -1 },
			{ ...delta, delta_sequence: 1_000_001 },
			{ ...delta, partial: {} },
		]) {
			assert.throws(() => parseDirectorTurnDelta(invalid));
		}
	});

	it("accepts exact bounded durable utterance seals but never persists deltas", () => {
		assert.deepEqual(parseDirectorTurnEvent(utterance), utterance);
		assert.deepEqual(parseDirectorTurnEvent({ ...utterance, through_delta_sequence: -1 }), {
			...utterance,
			through_delta_sequence: -1,
		});
		assert.equal(parseDirectorTurnEvent({ ...utterance, content: "🙂".repeat(4_096) }).type, utterance.type);
		for (const invalid of [
			{ ...utterance, content: "" },
			{ ...utterance, content: "x".repeat(16_385) },
			{ ...utterance, content: `${"🙂".repeat(4_096)}x` },
			{ ...utterance, content_index: 32 },
			{ ...utterance, through_delta_sequence: -2 },
			{ ...utterance, through_delta_sequence: 1_000_001 },
			{ ...utterance, metadata: {} },
		]) {
			assert.throws(() => parseDirectorTurnEvent(invalid));
		}
		const transcript = {
			type: "director_transcript",
			schema_version: 2,
			id: REQUEST_ID,
			session_id: SESSION_ID,
			events: [utterance],
			next_cursor: null,
			snapshot_cursor: 1,
		} as const;
		assert.deepEqual(parseDirectorTranscript(transcript), transcript);
		assert.throws(() => parseDirectorTranscript({ ...transcript, events: [delta] }));
	});

	it("supports legacy transcript pages and exact v2 watermark paging", () => {
		const legacyRequest = { type: "director_transcript_request", id: REQUEST_ID, cursor: 0, page_size: 64 } as const;
		assert.deepEqual(parseDirectorTranscriptRequest(legacyRequest), legacyRequest);
		const first = { ...legacyRequest, snapshot_cursor: null } as const;
		assert.deepEqual(parseDirectorTranscriptRequest(first), first);
		const next = { ...legacyRequest, cursor: 64, snapshot_cursor: 120 } as const;
		assert.deepEqual(parseDirectorTranscriptRequest(next), next);
		assert.throws(() => parseDirectorTranscriptRequest({ ...first, cursor: 1 }));
		assert.throws(() => parseDirectorTranscriptRequest({ ...next, cursor: 121 }));
		assert.throws(() => parseDirectorTranscriptRequest({ ...next, snapshot_cursor: 10_001 }));

		const legacyPage = {
			type: "director_transcript",
			id: REQUEST_ID,
			session_id: SESSION_ID,
			events: [],
			next_cursor: null,
		} as const;
		assert.deepEqual(parseDirectorTranscript(legacyPage), legacyPage);
		const page = { ...legacyPage, schema_version: 2, next_cursor: 64, snapshot_cursor: 120 } as const;
		assert.deepEqual(parseDirectorTranscript(page), page);
		assert.throws(() => parseDirectorTranscript({ ...page, next_cursor: 121 }));
		assert.throws(() => parseDirectorTranscript({ ...page, snapshot_cursor: 10_001 }));
		assert.throws(() => parseDirectorTranscript({ ...page, extra: true }));
	});

	it("adds a closed controller hello ack feature variant without weakening legacy ack", () => {
		const legacy = {
			type: "hello_ack",
			protocol: 1,
			daemon_version: "0.1.0",
			launch_id: LAUNCH_ID,
			session_id: SESSION_ID,
			server_nonce: "BBBBBBBBBBBBBBBBBBBBBB",
			capabilities: ["inspect_project", DIRECTOR_STREAM_CAPABILITY],
		} as const;
		assert.deepEqual(parseHelloAck(legacy), legacy);
		const featured = { ...legacy, protocol_features: [SNAPSHOT_CURSOR_V2_FEATURE] } as const;
		assert.deepEqual(parseHelloAck(featured), featured);
		assert.throws(() => parseHelloAck({ ...featured, protocol_features: [] }));
		assert.throws(() => parseHelloAck({ ...featured, protocol_features: ["future"] }));
		assert.throws(() => parseHelloAck({ ...featured, extra: true }));
	});

	it("parses exact bridge and controller-peer discovery variants in one direction", () => {
		assert.deepEqual(parseClientMessage(bridgePublication), bridgePublication);
		assert.deepEqual(parseClientMessage(peerPublication), peerPublication);
		assert.deepEqual(parseServerMessage(bridgePublicationAck), bridgePublicationAck);
		assert.deepEqual(parseServerMessage(peerPublicationAck), peerPublicationAck);
		assert.throws(() => parseClientMessage({ ...bridgePublication, lineage_id: LINEAGE_ID }));
		assert.throws(() => parseClientMessage({ type: peerPublication.type, id: ID }));
		assert.throws(() => parseServerMessage({ ...bridgePublicationAck, generation: 0 }));
		assert.throws(() => parseServerMessage({ ...peerPublicationAck, generation: 2_147_483_648 }));
		assert.throws(() => parseClientMessage(bridgePublicationAck));
		assert.throws(() => parseServerMessage(bridgePublication));
	});

	it("parses exact controller peer auth and revocation frames in one direction", () => {
		const revoke = { type: "revoke_controller_peer", id: ID, lineage_id: LINEAGE_ID } as const;
		const revokeAck = { ...revoke, type: "revoke_controller_peer_ack", status: "revoked" } as const;
		const auth = {
			type: "controller_peer_auth",
			resume_token: "A".repeat(43),
			launch_id: LAUNCH_ID,
			lineage_id: LINEAGE_ID,
			generation: 1,
			expires_in_ms: 300_000,
		} as const;
		assert.deepEqual(parseClientMessage(revoke), revoke);
		assert.deepEqual(parseServerMessage(revokeAck), revokeAck);
		assert.deepEqual(parseServerMessage(auth), auth);
		assert.throws(() => parseServerMessage({ ...auth, expires_in_ms: 299_999 }));
		assert.throws(() => parseServerMessage({ ...auth, generation: 0 }));
		assert.throws(() => parseServerMessage({ ...auth, resume_token: "A".repeat(42) }));
		assert.throws(() => parseClientMessage(revokeAck));
		assert.throws(() => parseServerMessage(revoke));
	});

	it("parses transaction frames only in their bridge direction", () => {
		for (const message of [prepared, acknowledged, reconcile]) {
			assert.deepEqual(parseAddonBridgeMessage(message, transactionSession()), message);
			assert.throws(() => parseDaemonBridgeMessage(message, transactionSession(), new Set()));
			assert.throws(() => parseAddonBridgeMessage({ ...message, extra: true }, transactionSession()));
		}
		for (const message of [ack, status, transactionError]) {
			assert.deepEqual(parseDaemonBridgeMessage(message, transactionSession(), new Set()), message);
			assert.throws(() => parseAddonBridgeMessage(message, transactionSession()));
			assert.throws(() => parseDaemonBridgeMessage({ ...message, extra: true }, transactionSession(), new Set()));
		}
	});

	it("enforces transaction unions, identifiers, phases, and exact error triples", () => {
		for (const operation of ["stage_scene", "apply_camera_plan"])
			assert.equal(parseAddonBridgeMessage({ ...prepared, operation }, transactionSession()).type, prepared.type);
		assert.throws(() => parseAddonBridgeMessage({ ...prepared, operation: "inspect_project" }, transactionSession()));
		assert.throws(() => parseAddonBridgeMessage({ ...prepared, transaction_id: HASH }, transactionSession()));
		for (const marker_phase of [
			"prepared",
			"candidate_saved",
			"manifest_committed",
			"acknowledged",
			"rollback_saved",
		]) {
			assert.equal(
				parseAddonBridgeMessage({ ...reconcile, marker_phase }, transactionSession()).type,
				reconcile.type,
			);
		}
		assert.throws(() => parseAddonBridgeMessage({ ...reconcile, marker_phase: "future" }, transactionSession()));
		for (const authority of ["base_authoritative", "candidate_authoritative", "unknown"])
			assert.equal(
				parseDaemonBridgeMessage({ ...status, status: authority }, transactionSession(), new Set()).type,
				status.type,
			);
		assert.throws(() => parseDaemonBridgeMessage({ ...status, status: "conflict" }, transactionSession(), new Set()));

		const errors = [
			["TRANSACTION_CONFLICT", "transaction id was reused with different content"],
			["TRANSACTION_NOT_FOUND", "transaction is unavailable"],
			["TRANSACTION_EVIDENCE_INVALID", "transaction recovery evidence is invalid"],
			["TRANSACTION_STATE_INVALID", "transaction phase is invalid"],
		] as const;
		for (const [code, message] of errors) {
			assert.equal(
				parseDaemonBridgeMessage({ ...transactionError, code, message }, transactionSession(), new Set()).type,
				transactionError.type,
			);
		}
		assert.throws(() =>
			parseDaemonBridgeMessage({ ...transactionError, message: "wrong" }, transactionSession(), new Set()),
		);
		assert.throws(() =>
			parseDaemonBridgeMessage({ ...transactionError, retryable: true }, transactionSession(), new Set()),
		);
	});

	it("requires transaction capability and fails closed for unknown messages both directions", () => {
		const session = negotiateMutationBridge(
			{
				type: "hello",
				protocol: 2,
				addon_version: "0.1.0",
				blender_version: "4.5.0",
				project_id: PROJECT_ID,
				client_nonce: "AAAAAAAAAAAAAAAAAAAAAA",
				capabilities: [MUTATION_CAPABILITY, STAGE_CAPABILITY],
			},
			{
				type: "hello_ack",
				protocol: 2,
				daemon_version: "0.1.0",
				launch_id: LAUNCH_ID,
				session_id: SESSION_ID,
				server_nonce: "BBBBBBBBBBBBBBBBBBBBBB",
				capabilities: [MUTATION_CAPABILITY, STAGE_CAPABILITY],
			},
		);
		assert.throws(() => parseAddonBridgeMessage(prepared, session), /transaction_commit_v2/);
		assert.throws(() => parseDaemonBridgeMessage(ack, session, new Set()), /transaction_commit_v2/);
		assert.throws(() => parseClientMessage({ type: "future_client_frame", id: ID }));
		assert.throws(() => parseServerMessage({ type: "future_server_frame", id: ID }));
		assert.throws(() => parseAddonBridgeMessage({ type: "future_transaction_frame" }, transactionSession()));
		assert.throws(() =>
			parseDaemonBridgeMessage({ type: "future_transaction_frame" }, transactionSession(), new Set()),
		);
	});
});
