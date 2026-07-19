import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
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

function credentialDigest(value: string): Buffer | undefined {
	if (!CREDENTIAL_PATTERN.test(value)) return undefined;
	try {
		const bytes = Buffer.from(value, "base64url");
		return bytes.byteLength === 32 ? bytes : undefined;
	} catch {
		return undefined;
	}
}

export class AttachTicketBroker {
	private readonly clock: Clock;
	private readonly ttlMs: number;
	private readonly tickets = new Map<string, TicketRecord>();

	constructor(clock: Clock, ttlMs = 10_000) {
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 60_000) {
			throw new Error("attach ticket TTL must be 100..60000 milliseconds");
		}
		this.clock = clock;
		this.ttlMs = ttlMs;
	}

	issue(role: AttachRole): IssuedAttachTicket {
		this.prune();
		const ticket = randomBytes(32).toString("base64url");
		const digest = credentialDigest(ticket);
		if (digest === undefined) throw new Error("failed to generate attach ticket");
		this.tickets.set(ticket, { digest, role, expiresAt: this.clock.now() + this.ttlMs });
		return { ticket, role, expiresInMs: this.ttlMs };
	}

	consume(candidate: string, role: ClientRole): boolean {
		const supplied = credentialDigest(candidate);
		if (supplied === undefined) return false;
		const record = this.tickets.get(candidate);
		if (record === undefined || role !== record.role) return false;
		if (this.clock.now() >= record.expiresAt) {
			this.tickets.delete(candidate);
			record.digest.fill(0);
			return false;
		}
		const valid =
			supplied.byteLength === record.digest.byteLength &&
			timingSafeEqual(supplied, record.digest);
		if (valid) {
			this.tickets.delete(candidate);
			record.digest.fill(0);
		}
		return valid;
	}

	zero(): void {
		for (const record of this.tickets.values()) record.digest.fill(0);
		this.tickets.clear();
	}

	private prune(): void {
		const now = this.clock.now();
		for (const [ticket, record] of this.tickets) {
			if (now >= record.expiresAt) {
				record.digest.fill(0);
				this.tickets.delete(ticket);
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
		return supplied !== undefined && timingSafeEqual(supplied, this.digest);
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

export interface RuntimeAdvertisement {
	readonly directory: string;
	readonly endpoint: RuntimeEndpoint;
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
	let cleaned = false;
	return {
		directory,
		endpoint,
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
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
