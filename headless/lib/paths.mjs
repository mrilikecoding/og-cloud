/** `inbox/foo.md` -> `foo` */
export function requestName(path, inboxDir) {
	return path.slice(inboxDir.length).replace(/\.md$/, "");
}

/** `foo` -> `results/foo.md` */
export function resultPath(name, resultsDir) {
	return `${resultsDir}${name}.md`;
}
