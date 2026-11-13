import { StudioProtocolError } from "../studio-agent-protocol.js";

const hostKey = (read) => JSON.stringify(read?.()?.host ?? null);

/** The fence to run once the project file is written (#1207). The command
 * deadline also runs while the user sits in the Save dialog, so after a write
 * an expired deadline alone does not make the save a failure: the file is on
 * disk. A document or scene that changed underneath still refuses the save. */
export function checkAfterWrite(context, read) {
	const before = hostKey(read);
	return () => {
		try {
			context.check();
		} catch (error) {
			if (error?.code !== "TIMEOUT" || context.signal?.reason !== error) throw error;
			if (hostKey(read) !== before) throw new StudioProtocolError("STALE_TARGET", "The open document or scene changed while the project was saving.");
		}
	};
}
