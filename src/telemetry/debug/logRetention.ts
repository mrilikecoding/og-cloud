/**
 * Day-level retention for the plugin's on-disk log roots.
 *
 * Extracted verbatim from FlightRecorder.enforceRetention so the plain trace
 * logger under logs/ can share it. Both roots are laid out the same way —
 * `<root>/YYYY-MM-DD/<file>` — and both are written by a debug mode that can
 * be left on for weeks on a phone, so neither may grow without bound.
 *
 * Deliberately narrow: only the adapter surface the algorithm touches, so it
 * can be driven by an in-memory fake in tests.
 */

export interface RetentionAdapter {
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<{ size: number } | null>;
	remove(path: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface RetentionPolicy {
	maxDays: number;
	maxTotalBytes: number;
}

const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Delete day directories older than `maxDays`, then the oldest remaining days
 * until the root is under `maxTotalBytes`. The current day is never deleted:
 * it is the log being written, and the per-file caps bound it instead.
 *
 * Never throws. A logging subsystem must not be able to break sync.
 */
export async function enforceLogRetention(
	adapter: RetentionAdapter,
	root: string,
	policy: RetentionPolicy,
): Promise<void> {
	try {
		if (!(await adapter.exists(root))) return;

		const listing = await adapter.list(root);
		const dayDirs = listing.folders
			.map((d) => d.split("/").pop() ?? "")
			.filter((d) => DAY_DIR.test(d))
			.sort(); // ascending: oldest first

		const today = new Date().toISOString().slice(0, 10);
		const cutoff = new Date(Date.now() - policy.maxDays * 86_400_000)
			.toISOString()
			.slice(0, 10);
		for (const dir of dayDirs) {
			if (dir < cutoff) {
				await deleteDirectory(adapter, `${root}/${dir}`);
			}
		}

		let totalBytes = await estimateTotalBytes(adapter, root);
		const remainingDirs = dayDirs.filter((d) => d >= cutoff && d !== today);
		for (const dir of remainingDirs) {
			if (totalBytes <= policy.maxTotalBytes) break;
			const dirSize = await estimateTotalBytes(adapter, `${root}/${dir}`);
			await deleteDirectory(adapter, `${root}/${dir}`);
			totalBytes -= dirSize;
		}
	} catch {
		// Retention enforcement failures are non-fatal.
	}
}

export async function estimateTotalBytes(
	adapter: RetentionAdapter,
	dir: string,
): Promise<number> {
	try {
		const listing = await adapter.list(dir);
		let total = 0;
		for (const filePath of listing.files) {
			try {
				const stat = await adapter.stat(filePath);
				total += stat?.size ?? 0;
			} catch { /* skip */ }
		}
		for (const subDir of listing.folders) {
			total += await estimateTotalBytes(adapter, subDir);
		}
		return total;
	} catch {
		return 0;
	}
}

export async function deleteDirectory(
	adapter: RetentionAdapter,
	dir: string,
): Promise<void> {
	try {
		const listing = await adapter.list(dir);
		for (const filePath of listing.files) {
			try {
				await adapter.remove(filePath);
			} catch { /* skip */ }
		}
		for (const subDir of listing.folders) {
			await deleteDirectory(adapter, subDir);
		}
		// Remove the now-empty directory (best-effort).
		try {
			await adapter.rmdir(dir, false);
		} catch { /* ok if not empty or not found */ }
	} catch { /* skip */ }
}
