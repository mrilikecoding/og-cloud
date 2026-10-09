import yaml from "js-yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a note into parsed frontmatter and body. Invalid YAML yields `error`. */
export function parseNote(text) {
	const m = text.match(FRONTMATTER);
	if (!m) return { frontmatter: {}, body: text };
	let frontmatter = {};
	try {
		const parsed = yaml.load(m[1]);
		if (parsed && typeof parsed === "object") frontmatter = parsed;
	} catch (err) {
		return { frontmatter: {}, body: text, error: `frontmatter: ${err.message}` };
	}
	return { frontmatter, body: text.slice(m[0].length) };
}

/** Frontmatter `tags` as a list of bare names: accepts a list or a comma/space separated string. */
export function tagList(tags) {
	const raw = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[,\s]+/) : [];
	return raw.filter((t) => typeof t === "string").map((t) => t.replace(/^#/, "").trim());
}
