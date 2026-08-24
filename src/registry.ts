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
	/** Present only where a dialog can actually be shown. */
	escalate?: (toolName: string, reason: string) => Promise<EscalationChoice>;
}

/** What the user chose at an escalation prompt. Mirrors the gate's own type. */
export type EscalationChoice = "once" | "session" | "deny";

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

/**
 * Ask an interactive session to decide a call a headless one cannot prompt about.
 *
 * This is the answer to "the subagent has nobody to ask": it borrows the parent's dialog. Only one
 * session is asked, because two prompts for one call would be worse than none.
 *
 * `timeoutMs` has to stay well inside omp's `extensionHandlers.toolCallTimeoutMs` (30s by default),
 * since overrunning that turns the call into a block with a timeout reason instead of a decision. An
 * unanswered or broken prompt resolves to `deny`, so silence never reads as consent.
 */
export async function requestParentEscalation(
	childSessionId: string,
	toolName: string,
	reason: string,
	timeoutMs: number,
): Promise<EscalationChoice> {
	for (const [id, hooks] of sessions) {
		if (id === childSessionId || !hooks.hasUI || hooks.escalate === undefined) continue;
		const timeout = Promise.withResolvers<EscalationChoice>();
		const timer = setTimeout(() => timeout.resolve("deny"), timeoutMs);
		try {
			return await Promise.race([hooks.escalate(toolName, reason), timeout.promise]);
		} catch {
			return "deny";
		} finally {
			clearTimeout(timer);
		}
	}
	return "deny";
}
