import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Clock } from "./token.ts";

export type ClientRole = "controller" | "bridge" | "legacy";
export type AttachRole = "bridge";

export interface IssuedAttachTicket {
	readonly ticket: string;
	readonly role: AttachRole;
	readonly expiresInMs: number;
}

type TicketRecord = {
	readonly digest: Buffer;
	readonly role: AttachRole;
	readonly expiresAt: number;
};

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DISCOVERY_TTL_MS = 15_000;
const PEER_RESUME_TTL_MS = 300_000;

function credentialDigest(value: string): Buffer | undefined {
	if (!CREDENTIAL_PATTERN.test(value)) return undefined;
	try {
		const bytes = Buffer.from(value, "base64url");
		if (bytes.byteLength !== 32) return undefined;
		const digest = createHash("sha256").update(bytes).digest();
		bytes.fill(0);
		return digest;
	} catch {
		return undefined;
	}
}

function digestKey(digest: Buffer): string {
	return digest.toString("hex");
}

export class AttachTicketBroker {
	private readonly clock: Clock;
	private readonly ttlMs: number;
	private readonly tickets = new Map<string, TicketRecord>();

	constructor(clock: Clock, ttlMs = DISCOVERY_TTL_MS) {
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 60_000) {
			throw new Error("attach ticket TTL must be 100..60000 milliseconds");
		}
		this.clock = clock;
		this.ttlMs = ttlMs;
	}

	issue(role: AttachRole): IssuedAttachTicket {
		this.zero();
		const ticket = randomBytes(32).toString("base64url");
		const digest = credentialDigest(ticket);
		if (digest === undefined) throw new Error("failed to generate attach ticket");
		this.tickets.set(digestKey(digest), { digest, role, expiresAt: this.clock.now() + this.ttlMs });
		return { ticket, role, expiresInMs: this.ttlMs };
	}

	consume(candidate: string, role: ClientRole): boolean {
		const supplied = credentialDigest(candidate);
		if (supplied === undefined) return false;
		const key = digestKey(supplied);
		const record = this.tickets.get(key);
		if (record === undefined || role !== record.role) {
			supplied.fill(0);
			return false;
		}
		if (this.clock.now() >= record.expiresAt) {
			this.tickets.delete(key);
			record.digest.fill(0);
			supplied.fill(0);
			return false;
		}
		const valid = timingSafeEqual(supplied, record.digest);
		if (valid) {
			this.tickets.delete(key);
			record.digest.fill(0);
		}
		supplied.fill(0);
		return valid;
	}

	zero(): void {
		for (const record of this.tickets.values()) record.digest.fill(0);
		this.tickets.clear();
	}
}

export type CredentialRole = "bridge" | "owner" | "peer";

export interface CredentialPrincipal {
	readonly projectId: string;
	readonly authority: string;
	readonly lineageId: string;
	readonly generation: number;
	readonly role: CredentialRole;
}

export interface IssuedProjectCredential {
	readonly ticket: string;
	readonly principal: CredentialPrincipal;
	readonly expiresInMs: 15_000;
}

export interface PeerAuthentication {
	readonly principal: CredentialPrincipal;
	readonly resumeToken: string;
	readonly expiresInMs: 300_000;
}

type ProjectCredentialRecord = {
	readonly digest: Buffer;
	readonly principal: CredentialPrincipal;
	readonly expiresAt: number;
};

export class ProjectCredentialBroker {
	private readonly tickets = new Map<string, ProjectCredentialRecord>();
	private readonly resumes = new Map<string, ProjectCredentialRecord>();
	private readonly generations = new Map<string, number>();
	private readonly clock: Clock;

	constructor(clock: Clock) {
		this.clock = clock;
	}

	publishBridge(input: Omit<CredentialPrincipal, "generation" | "role">): IssuedProjectCredential {
		return this.publish("bridge", input);
	}

	publishControllerPeer(input: Omit<CredentialPrincipal, "generation" | "role">): IssuedProjectCredential {
		return this.publish("peer", input);
	}

	consumeBridge(ticket: string, projectId: string): CredentialPrincipal | undefined {
		return this.consumeTicket(ticket, "bridge", projectId)?.principal;
	}

	consumeControllerPeer(ticket: string, projectId: string): PeerAuthentication | undefined {
		const record = this.consumeTicket(ticket, "peer", projectId);
		return record === undefined ? undefined : this.issueResume(record.principal);
	}

	resumeControllerPeer(token: string, projectId: string): PeerAuthentication | undefined {
		const record = this.take(this.resumes, token);
		if (record === undefined) return undefined;
		const valid = record.principal.projectId === projectId && this.isCurrent(record.principal) &&
			this.clock.now() < record.expiresAt;
		record.digest.fill(0);
		if (!valid) return undefined;
		const generation = record.principal.generation + 1;
		if (generation > 2_147_483_647) throw new Error("credential generation exhausted");
		const principal = Object.freeze({ ...record.principal, generation });
		this.generations.set(this.slotKey("peer", principal.lineageId), generation);
		return this.issueResume(principal);
	}

	revokeControllerPeer(lineageId: string): void {
		this.revoke("peer", lineageId);
		this.generations.delete(this.slotKey("peer", lineageId));
	}

	revokeBridge(lineageId: string): void {
		this.revoke("bridge", lineageId);
	}

	zero(): void {
		for (const records of [this.tickets, this.resumes]) {
			for (const record of records.values()) record.digest.fill(0);
			records.clear();
		}
		this.generations.clear();
	}
	private revoke(role: "bridge" | "peer", lineageId: string): void {
		for (const records of [this.tickets, this.resumes]) {
			for (const [key, record] of records) {
				if (record.principal.role === role && record.principal.lineageId === lineageId) {
					record.digest.fill(0);
					records.delete(key);
				}
			}
		}
	}

	private publish(
		role: "bridge" | "peer",
		input: Omit<CredentialPrincipal, "generation" | "role">,
	): IssuedProjectCredential {
		this.prune();
		const slot = this.slotKey(role, input.lineageId);
		const generation = (this.generations.get(slot) ?? 0) + 1;
		if (generation > 2_147_483_647) throw new Error("credential generation exhausted");
		this.generations.set(slot, generation);
		for (const records of [this.tickets, this.resumes]) {
			for (const [key, record] of records) {
				if (record.principal.role === role && record.principal.lineageId === input.lineageId) {
					record.digest.fill(0);
					records.delete(key);
				}
			}
		}
		const principal: CredentialPrincipal = Object.freeze({ ...input, generation, role });
		const ticket = randomBytes(32).toString("base64url");
		const digest = credentialDigest(ticket);
		if (digest === undefined) throw new Error("failed to generate project credential");
		this.tickets.set(digestKey(digest), {
			digest,
			principal,
			expiresAt: this.clock.now() + DISCOVERY_TTL_MS,
		});
		return { ticket, principal, expiresInMs: DISCOVERY_TTL_MS };
	}

	private consumeTicket(
		ticket: string,
		role: "bridge" | "peer",
		projectId: string,
	): ProjectCredentialRecord | undefined {
		const record = this.take(this.tickets, ticket);
		if (record === undefined) return undefined;
		const valid = record.principal.role === role && record.principal.projectId === projectId &&
			this.isCurrent(record.principal) && this.clock.now() < record.expiresAt;
		record.digest.fill(0);
		return valid ? record : undefined;
	}

	private issueResume(principal: CredentialPrincipal): PeerAuthentication {
		const resumeToken = randomBytes(32).toString("base64url");
		const digest = credentialDigest(resumeToken);
		if (digest === undefined) throw new Error("failed to generate peer resume credential");
		this.resumes.set(digestKey(digest), {
			digest,
			principal,
			expiresAt: this.clock.now() + PEER_RESUME_TTL_MS,
		});
		return { principal, resumeToken, expiresInMs: PEER_RESUME_TTL_MS };
	}

	private take(
		records: Map<string, ProjectCredentialRecord>,
		credential: string,
	): ProjectCredentialRecord | undefined {
		const supplied = credentialDigest(credential);
		if (supplied === undefined) return undefined;
		const key = digestKey(supplied);
		const record = records.get(key);
		supplied.fill(0);
		if (record !== undefined) records.delete(key);
		return record;
	}

	private isCurrent(principal: CredentialPrincipal): boolean {
		return this.generations.get(this.slotKey(principal.role, principal.lineageId)) === principal.generation;
	}

	private slotKey(role: CredentialRole, lineageId: string): string {
		return `${role}:${lineageId}`;
	}

	private prune(): void {
		const now = this.clock.now();
		for (const records of [this.tickets, this.resumes]) {
			for (const [key, record] of records) {
				if (now >= record.expiresAt) {
					record.digest.fill(0);
					records.delete(key);
				}
			}
		}
	}
}

export class ControllerCredential {
	readonly value: string;
	private readonly digest: Buffer;
	private zeroed = false;

	constructor() {
		this.value = randomBytes(32).toString("base64url");
		const digest = credentialDigest(this.value);
		if (digest === undefined) throw new Error("failed to generate controller credential");
		this.digest = digest;
	}

	matches(candidate: string): boolean {
		if (this.zeroed) return false;
		const supplied = credentialDigest(candidate);
		if (supplied === undefined) return false;
		const valid = timingSafeEqual(supplied, this.digest);
		supplied.fill(0);
		return valid;
	}

	zero(): void {
		this.zeroed = true;
		this.digest.fill(0);
	}
}

export class OwnerCredential {
	readonly value: string;
	readonly principal: CredentialPrincipal;
	private readonly digest: Buffer;
	private zeroed = false;

	constructor(principal: Omit<CredentialPrincipal, "generation" | "role">) {
		this.principal = Object.freeze({ ...principal, generation: 1, role: "owner" });
		this.value = randomBytes(32).toString("base64url");
		const digest = credentialDigest(this.value);
		if (digest === undefined) throw new Error("failed to generate owner credential");
		this.digest = digest;
	}

	matches(candidate: string, projectId: string): boolean {
		if (this.zeroed || projectId !== this.principal.projectId) return false;
		const supplied = credentialDigest(candidate);
		if (supplied === undefined) return false;
		const valid = timingSafeEqual(supplied, this.digest);
		supplied.fill(0);
		return valid;
	}

	zero(): void {
		this.zeroed = true;
		this.digest.fill(0);
	}
}

export interface RuntimeEndpoint {
	readonly schema_version: 1;
	readonly launch_id: string;
	readonly host: "127.0.0.1";
	readonly port: number;
}

export interface AttachHandoff {
	readonly schema_version: 1;
	readonly project_id: string;
	readonly ticket: string;
	readonly expires_at_ms: number;
}

export interface BridgeDiscoverySlot extends AttachHandoff {
	readonly generation: number;
}

export interface ControllerPeerDiscoverySlot extends BridgeDiscoverySlot {
	readonly lineage_id: string;
}

export interface RuntimeAdvertisement {
	readonly directory: string;
	readonly endpoint: RuntimeEndpoint;
	writeBridgeSlot(slot: BridgeDiscoverySlot): Promise<void>;
	removeBridgeSlot(): Promise<void>;
	writeControllerPeerSlot(slot: ControllerPeerDiscoverySlot): Promise<void>;
	removeControllerPeerSlot(): Promise<void>;
	writeAttachHandoff(handoff: AttachHandoff): Promise<void>;
	removeAttachHandoff(): Promise<void>;
	cleanup(): Promise<void>;
}

function ownerUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function verifyPrivateDirectory(directory: string): Promise<void> {
	const metadata = await lstat(directory);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error(`UNSAFE_RUNTIME_DIRECTORY: ${directory} is not a nonsymlink directory`);
	}
	const uid = ownerUid();
	if (uid !== undefined && metadata.uid !== uid) {
		throw new Error(`UNSAFE_RUNTIME_DIRECTORY: ${directory} is not owned by the current user`);
	}
	if ((metadata.mode & 0o077) !== 0) {
		throw new Error(`UNSAFE_RUNTIME_DIRECTORY: ${directory} must have mode 0700`);
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await verifyPrivateDirectory(directory);
}

export async function createRuntimeAdvertisement(options: {
	readonly launchId: string;
	readonly port: number;
	readonly baseDirectory?: string;
}): Promise<RuntimeAdvertisement> {
	const baseDirectory = options.baseDirectory ??
		(process.env.XDG_RUNTIME_DIR && path.isAbsolute(process.env.XDG_RUNTIME_DIR)
			? process.env.XDG_RUNTIME_DIR
			: os.tmpdir());
	const uid = ownerUid() ?? "user";
	const userDirectory = path.join(baseDirectory, `omb-${uid}`);
	const directory = path.join(userDirectory, options.launchId);
	await ensurePrivateDirectory(userDirectory);
	await ensurePrivateDirectory(directory);
	const endpoint: RuntimeEndpoint = {
		schema_version: 1,
		launch_id: options.launchId,
		host: "127.0.0.1",
		port: options.port,
	};
	const endpointPath = path.join(directory, "endpoint.json");
	const handle = await open(endpointPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(endpoint)}\n`, { encoding: "utf8" });
		await handle.sync();
	} finally {
		await handle.close();
	}
	const written = await readFile(endpointPath, "utf8");
	if (written !== `${JSON.stringify(endpoint)}\n`) {
		throw new Error("RUNTIME_ADVERTISEMENT_FAILED: endpoint verification failed");
	}
	const handoffPath = path.join(directory, "attach-handoff.json");
	const bridgeSlotPath = path.join(directory, "bridge-slot.json");
	const peerSlotPath = path.join(directory, "controller-peer-slot.json");
	let slotWrite = Promise.resolve();
	const removeFile = async (filePath: string) => {
		try {
			await unlink(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	const writeFileAtomically = (filePath: string, value: unknown) => {
		const write = slotWrite.then(async () => {
			const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomBytes(16).toString("hex")}.tmp`);
			const contents = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
			let handle;
			try {
				handle = await open(temporaryPath, "wx", 0o600);
				await handle.writeFile(contents);
				await handle.sync();
				await handle.close();
				handle = undefined;
				await rename(temporaryPath, filePath);
			} finally {
				contents.fill(0);
				await handle?.close();
				await removeFile(temporaryPath);
			}
		});
		slotWrite = write.catch(() => undefined);
		return write;
	};
	const removeSerialized = (filePath: string) => {
		const removal = slotWrite.then(() => removeFile(filePath));
		slotWrite = removal.catch(() => undefined);
		return removal;
	};
	let cleaned = false;
	return {
		directory,
		endpoint,
		writeBridgeSlot: (slot) => writeFileAtomically(bridgeSlotPath, slot),
		removeBridgeSlot: () => removeSerialized(bridgeSlotPath),
		writeControllerPeerSlot: (slot) => writeFileAtomically(peerSlotPath, slot),
		removeControllerPeerSlot: () => removeSerialized(peerSlotPath),
		writeAttachHandoff: (handoff) => writeFileAtomically(handoffPath, handoff),
		removeAttachHandoff: () => removeSerialized(handoffPath),
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
			await slotWrite;
			await Promise.all([
				removeFile(handoffPath),
				removeFile(bridgeSlotPath),
				removeFile(peerSlotPath),
			]);
			try {
				await unlink(endpointPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				await rmdir(directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				await rmdir(userDirectory);
			} catch (error) {
				if (!(["ENOENT", "ENOTEMPTY"] as const).includes((error as NodeJS.ErrnoException).code as "ENOENT" | "ENOTEMPTY")) {
					throw error;
				}
			}
		},
	};
}
