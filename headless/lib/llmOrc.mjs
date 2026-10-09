/** POST the request body to an llm-orc ensemble and return the JSON envelope. */
export async function runEnsemble({ url, name, input, timeoutMs, fetchImpl = fetch }) {
	const res = await fetchImpl(`${url}/api/ensembles/${encodeURIComponent(name)}/execute`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ input }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let envelope;
	try {
		envelope = JSON.parse(text);
	} catch {
		throw new Error(`llm-orc ${res.status}: ${text.slice(0, 300)}`);
	}
	if (!res.ok) throw new Error(`llm-orc ${res.status}: ${JSON.stringify(envelope).slice(0, 300)}`);
	return envelope;
}
