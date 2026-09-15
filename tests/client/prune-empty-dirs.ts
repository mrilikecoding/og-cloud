import { pruneEmptyParents, type PruneDeps } from "../../src/sync/pruneEmptyDirs";
import { suite } from "../harness.ts";

const s = suite("prune-empty-dirs");

function fakeFs(tree: Record<string, { files: string[]; folders: string[] }>) {
	const removed: string[] = [];
	const deps: PruneDeps = {
		configDir: ".obsidian",
		list: async (dir) => {
			const entry = tree[dir];
			if (!entry) throw new Error(`ENOENT ${dir}`);
			return { files: [...entry.files], folders: [...entry.folders] };
		},
		remove: async (dir) => {
			removed.push(dir);
			delete tree[dir];
			const parent = dir.slice(0, dir.lastIndexOf("/"));
			if (tree[parent]) tree[parent].folders = tree[parent].folders.filter((f) => f !== dir);
		},
	};
	return { deps, removed };
}

s.section("Test 1: empty parent chain is removed up to the vault root");
{
	const { deps, removed } = fakeFs({
		"a": { files: [], folders: ["a/b"] },
		"a/b": { files: [], folders: [] },
	});
	await pruneEmptyParents(deps, "a/b/gone.md");
	s.check(removed.join(",") === "a/b,a", "removes a/b then a");
}

s.section("Test 2: stops at the first folder that still has a file");
{
	const { deps, removed } = fakeFs({
		"a": { files: ["a/keep.md"], folders: ["a/b"] },
		"a/b": { files: [], folders: [] },
	});
	await pruneEmptyParents(deps, "a/b/gone.md");
	s.check(removed.join(",") === "a/b", "removes only the empty leaf");
}

s.section("Test 3: a sibling folder keeps the parent alive");
{
	const { deps, removed } = fakeFs({
		"a": { files: [], folders: ["a/b", "a/c"] },
		"a/b": { files: [], folders: [] },
		"a/c": { files: ["a/c/x.png"], folders: [] },
	});
	await pruneEmptyParents(deps, "a/b/gone.md");
	s.check(removed.join(",") === "a/b", "parent with another subfolder is kept");
}

s.section("Test 4: .DS_Store does not keep a folder alive, but other hidden files do");
{
	const one = fakeFs({ "a": { files: ["a/.DS_Store"], folders: [] } });
	await pruneEmptyParents(one.deps, "a/gone.md");
	s.check(one.removed.join(",") === "a", ".DS_Store-only folder is pruned");
	const two = fakeFs({ "a": { files: ["a/.gitkeep"], folders: [] } });
	await pruneEmptyParents(two.deps, "a/gone.md");
	s.check(two.removed.length === 0, "folder holding another hidden file is kept");
}

s.section("Test 5: config directory and root-level files are never touched");
{
	const cfg = fakeFs({ ".obsidian/plugins/x": { files: [], folders: [] }, ".obsidian/plugins": { files: [], folders: [".obsidian/plugins/x"] } });
	await pruneEmptyParents(cfg.deps, ".obsidian/plugins/x/data.json");
	s.check(cfg.removed.length === 0, "nothing under the config dir is pruned");
	const root = fakeFs({});
	await pruneEmptyParents(root.deps, "note.md");
	s.check(root.removed.length === 0, "a root-level file has no parent to prune");
}

s.section("Test 6: a folder that already vanished is not an error");
{
	const { deps, removed } = fakeFs({});
	await pruneEmptyParents(deps, "a/b/gone.md");
	s.check(removed.length === 0, "missing parent ends the walk quietly");
}

await s.done();
