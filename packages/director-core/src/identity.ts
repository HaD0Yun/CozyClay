import { randomUUID } from "node:crypto";

const UUID_V4_LOWERCASE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4Lowercase(value: unknown): value is string {
	return typeof value === "string" && UUID_V4_LOWERCASE.test(value);
}

export function newUuidV4(): string {
	const value = randomUUID();
	if (!isUuidV4Lowercase(value)) throw new Error("node:crypto randomUUID returned a non-lowercase UUIDv4");
	return value;
}
