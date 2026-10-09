import { parseNote } from "./frontmatter.mjs";
import { requestName, resultPath } from "./paths.mjs";
import { resultNote } from "./resultNote.mjs";
import { createFile, liveFiles, textOf } from "./vault.mjs";

/**
 * The request loop over a Y.Doc. No socket in here: the caller feeds it a doc
 * and calls `scan()` when the doc changes.
 *
 * cfg: { device, inboxDir, resultsDir }; run(ensemble, input) -> envelope.
 */
export function createInbox({ ydoc, cfg, run, log = () => {} }) {
	const inFlight = new Set();

	async function handleRequest(path, fileId) {
		const name = requestName(path, cfg.inboxDir);
		const text = textOf(ydoc, fileId);
		if (text === null) return;
		const { frontmatter, body, error: fmError } = parseNote(text);
		const ensemble = typeof frontmatter.agent === "string" ? frontmatter.agent.trim() : null;
		if (!ensemble && !fmError) return; // not a request (or not finished being typed)

		inFlight.add(path);
		const startedAt = new Date();
		log(`request ${path} -> ensemble ${ensemble ?? "?"}`);
		let envelope = null;
		let error = fmError ?? null;
		if (!error) {
			try {
				envelope = await run(ensemble, body.trim());
			} catch (err) {
				error = err.message;
			}
		}
		const finishedAt = new Date();
		try {
			const target = resultPath(name, cfg.resultsDir);
			if (liveFiles(ydoc).has(target)) {
				log(`result ${target} appeared meanwhile; not overwriting`);
			} else {
				const note = resultNote({
					name,
					requestPath: path,
					ensemble: ensemble ?? "",
					envelope,
					error,
					startedAt,
					finishedAt,
					runner: cfg.device,
				});
				createFile(ydoc, target, note, cfg.device);
				log(`result ${target} (${error ? "error" : envelope?.status}, ${Math.round((finishedAt - startedAt) / 1000)} s)`);
			}
		} catch (err) {
			log(`could not write result for ${path}: ${err.message}`);
		} finally {
			inFlight.delete(path);
		}
	}

	/** Start a run for every request note without a result. Resolves when those runs finish. */
	function scan() {
		const files = liveFiles(ydoc);
		const started = [];
		for (const [path, fileId] of files) {
			if (!path.startsWith(cfg.inboxDir) || !path.endsWith(".md")) continue;
			if (inFlight.has(path)) continue;
			if (files.has(resultPath(requestName(path, cfg.inboxDir), cfg.resultsDir))) continue; // done
			started.push(handleRequest(path, fileId));
		}
		return Promise.all(started);
	}

	return { scan, inFlight };
}
