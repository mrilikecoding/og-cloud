/**
 * Clean stop: wait up to `timeoutMs` for in-flight result writes, give the
 * socket a moment to flush them, then disconnect.
 */
export async function shutdown({ inbox, disconnect, timeoutMs = 10_000, settleMs = 500, log = (_message) => {} }) {
	const drained = await inbox.drain(timeoutMs);
	log(drained ? "in-flight requests finished" : `in-flight requests still running after ${timeoutMs} ms`);
	await new Promise((resolve) => setTimeout(resolve, settleMs));
	disconnect();
}
