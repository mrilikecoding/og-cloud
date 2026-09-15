import { type App, TFolder } from "obsidian";

/**
 * Sync tracks files, not folders.  When a remote delete removes the last
 * file in a folder, nothing in the document says "and the folder", so the
 * empty shell lingers on every other device.  This walks up from the deleted
 * file and removes parents that are now empty, stopping at the first one that
 * still holds anything (hidden entries count) and never touching the vault
 * root or the config directory.
 */
export interface PruneDeps {
	configDir: string;
	list(dir: string): Promise<{ files: string[]; folders: string[] }>;
	remove(dir: string): Promise<void>;
	log?(msg: string): void;
}

/** Finder droppings that should not keep a folder alive. */
const IGNORABLE = new Set([".DS_Store"]);

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "" : path.slice(0, i);
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export async function pruneEmptyParents(deps: PruneDeps, deletedFilePath: string): Promise<string[]> {
	const removed: string[] = [];
	const configDir = (deps.configDir || ".obsidian").replace(/\/+$/, "");
	let dir = parentOf(deletedFilePath);
	while (dir) {
		if (dir === configDir || dir.startsWith(`${configDir}/`)) break;
		let listing: { files: string[]; folders: string[] };
		try {
			listing = await deps.list(dir);
		} catch {
			break; // already gone, or unreadable: nothing more to do
		}
		const keep = listing.files.filter((f) => !IGNORABLE.has(basename(f)));
		if (keep.length > 0 || listing.folders.length > 0) break;
		try {
			await deps.remove(dir);
			removed.push(dir);
			deps.log?.(`pruned empty folder "${dir}" after remote delete`);
		} catch (err) {
			deps.log?.(`could not prune empty folder "${dir}": ${String(err)}`);
			break;
		}
		dir = parentOf(dir);
	}
	return removed;
}

export function pruneDepsFromApp(app: App, log?: (msg: string) => void): PruneDeps {
	return {
		configDir: app.vault.configDir ?? ".obsidian",
		list: (dir) => app.vault.adapter.list(dir),
		remove: async (dir) => {
			// Prefer the vault API so Obsidian's index and trash preference apply;
			// fall back to the adapter for folders the index does not know about.
			const folder = app.vault.getAbstractFileByPath(dir);
			if (folder instanceof TFolder) {
				await app.fileManager.trashFile(folder);
			} else {
				await app.vault.adapter.rmdir(dir, true);
			}
		},
		log,
	};
}
