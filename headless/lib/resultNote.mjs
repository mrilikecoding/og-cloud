import yaml from "js-yaml";

/**
 * Render a result note. The frontmatter is dumped from an object, never built
 * by hand: the plugin's frontmatter guard quarantines a note whose YAML does
 * not parse.
 */
export function resultNote({ name, requestPath, ensemble, envelope, error, startedAt, finishedAt, runner }) {
	const status = error ? "error" : envelope?.status ?? "unknown";
	const fm = {
		type: "log",
		tags: ["agent", "ai-tools"],
		created: finishedAt.toISOString().slice(0, 10),
		request: `[[${requestPath.replace(/\.md$/, "")}]]`,
		ensemble,
		status,
		duration_s: Math.round((finishedAt - startedAt) / 1000),
		runner,
	};
	const lines = ["---", yaml.dump(fm, { lineWidth: -1, flowLevel: 1 }).trimEnd(), "---", "", `# ${name}`, ""];
	if (error) {
		lines.push("## Error", "", "```", String(error), "```", "");
	} else {
		const deliverable = envelope.deliverable;
		const out = typeof deliverable === "string" ? deliverable : "```json\n" + JSON.stringify(deliverable, null, 2) + "\n```";
		lines.push(out.trimEnd(), "");
		const agents = envelope.results ?? {};
		const rows = Object.entries(agents).map(([agent, r]) => `| ${agent} | ${r?.status ?? ""} |`);
		if (rows.length) lines.push("## Agents", "", "| agent | status |", "| --- | --- |", ...rows, "");
	}
	return lines.join("\n");
}
