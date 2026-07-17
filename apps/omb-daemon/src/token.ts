import { randomBytes, timingSafeEqual } from "node:crypto";

export type Clock = { now(): number };
export const systemClock: Clock = { now: () => performance.now() };

export class BearerToken {
	readonly value: string;
	private bytes: Buffer;
	private expiresAt: number | undefined;
	private consumed = false;

	constructor(private readonly clock: Clock = systemClock, bytes = randomBytes(32)) {
		if (bytes.length !== 32) throw new Error("bearer token must be 32 bytes");
		this.bytes = Buffer.from(bytes);
		this.value = this.bytes.toString("base64url");
	}

	startExpiry(): void { this.expiresAt = this.clock.now() + 10_000; }
	isExpired(): boolean { return this.expiresAt !== undefined && this.clock.now() >= this.expiresAt; }
	consume(candidate: string): boolean {
		if (this.consumed || this.expiresAt === undefined || this.isExpired()) return false;
		if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false;
		let supplied: Buffer;
		try { supplied = Buffer.from(candidate, "base64url"); } catch { return false; }
		if (supplied.length !== this.bytes.length || !timingSafeEqual(supplied, this.bytes)) return false;
		this.consumed = true;
		this.bytes.fill(0);
		return true;
	}
	zero(): void { this.consumed = true; this.bytes.fill(0); }
}

export const randomNonce = (): string => randomBytes(16).toString("base64url");
