/**
 * Cross-session denial reporting.
 *
 * A subagent runs headless: `ctx.hasUI` is false, there is no dialog to escalate to, and its transcript
 * is rarely read. A denial inside one would otherwise be invisible to the person who started the work.
 *
 * omp gives an extension no handle on the session that spawned a subagent — `session_start` carries no
 * id, and there is no parent reference on the context — so this uses the one channel that does exist:
 * module-level state, which is shared by every session in the process because they all import the same
 * module instance. Every interactive session is notified rather than a specific parent, since the real
 * parent cannot be identified from here.
 */

interface SessionHooks {
	hasUI: boolean;
	notify: (message: string) => void;
}

const sessions = new Map<string, SessionHooks>();

export function registerSession(sessionId: string, hooks: SessionHooks): void {
	sessions.set(sessionId, hooks);
}

export function unregisterSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Announce a denial that happened in a headless session to whoever can actually see a message. */
export function reportChildDenial(childSessionId: string, toolName: string, reason: string): void {
	const message = `autoclassifier blocked \`${toolName}\` in subagent ${childSessionId}: ${reason}`;
	for (const [id, hooks] of sessions) {
		if (id === childSessionId || !hooks.hasUI) continue;
		try {
			hooks.notify(message);
		} catch {
			// A torn-down UI must not stop the remaining sessions from hearing about it.
		}
	}
}

/** Test seam: drop every registration. */
export function resetRegistry(): void {
	sessions.clear();
}
