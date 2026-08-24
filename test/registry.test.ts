import { afterEach, describe, expect, test } from "bun:test";
import { registerSession, reportChildDenial, requestParentEscalation, unregisterSession } from "../src/registry";

const registered: string[] = [];

function register(id: string, sink: string[]): void {
	registered.push(id);
	registerSession(id, {
		hasUI: true,
		notify: message => {
			sink.push(message);
		},
	});
}

afterEach(() => {
	for (const id of registered.splice(0)) unregisterSession(id);
});

/**
 * A subagent has no UI to escalate to and its transcript is rarely read, so a denial inside one would
 * otherwise be invisible. The registry is module-level state, which is shared across every session in
 * the process, and is the only channel available: an extension cannot reach a parent session directly.
 */
describe("cross-session denial reporting", () => {
	test("an interactive session is told about a child denial", () => {
		const parent: string[] = [];
		register("parent", parent);
		reportChildDenial("child-1", "write", "Adds an SSH key.");
		expect(parent.length).toBe(1);
		expect(parent[0]).toContain("write");
		expect(parent[0]).toContain("Adds an SSH key.");
	});

	test("the reporting child is not notified about itself", () => {
		const child: string[] = [];
		register("child-1", child);
		reportChildDenial("child-1", "write", "nope");
		expect(child).toEqual([]);
	});

	test("every interactive session hears about it, since the real parent is not identifiable", () => {
		const first: string[] = [];
		const second: string[] = [];
		register("session-a", first);
		register("session-b", second);
		reportChildDenial("child-1", "bash", "Force pushes.");
		expect(first.length).toBe(1);
		expect(second.length).toBe(1);
	});

	test("headless sessions are not notified, because nobody would see it", () => {
		const headless: string[] = [];
		registered.push("headless");
		registerSession("headless", {
			hasUI: false,
			notify: message => {
				headless.push(message);
			},
		});
		reportChildDenial("child-1", "bash", "nope");
		expect(headless).toEqual([]);
	});

	test("an unregistered session stops hearing about denials", () => {
		const sink: string[] = [];
		register("parent", sink);
		unregisterSession("parent");
		registered.length = 0;
		reportChildDenial("child-1", "bash", "nope");
		expect(sink).toEqual([]);
	});

	test("reporting with nothing registered does not throw", () => {
		expect(() => reportChildDenial("orphan", "bash", "nope")).not.toThrow();
	});

	test("one failing listener does not rob the others of the message", () => {
		const good: string[] = [];
		registered.push("broken", "good");
		registerSession("broken", {
			hasUI: true,
			notify: () => {
				throw new Error("ui is gone");
			},
		});
		registerSession("good", {
			hasUI: true,
			notify: message => {
				good.push(message);
			},
		});
		expect(() => reportChildDenial("child-1", "bash", "nope")).not.toThrow();
		expect(good.length).toBe(1);
	});

	test("re-registering the same id replaces the old listener rather than doubling it", () => {
		const first: string[] = [];
		const second: string[] = [];
		register("parent", first);
		register("parent", second);
		reportChildDenial("child-1", "bash", "nope");
		expect(first).toEqual([]);
		expect(second.length).toBe(1);
	});

	test("the message names the child so a fleet of subagents stays distinguishable", () => {
		const parent: string[] = [];
		register("parent", parent);
		reportChildDenial("scout-42", "bash", "nope");
		expect(parent[0]).toContain("scout-42");
	});
});

/**
 * A subagent is headless, so its own gate has nobody to ask. Rather than refusing outright it borrows the
 * parent's UI through this same registry, which is the only cross-session channel omp exposes.
 *
 * The budget matters: omp bounds each `tool_call` handler by `extensionHandlers.toolCallTimeoutMs`
 * (30s by default) and turns an overrun into a block. A prompt nobody answers therefore has to resolve
 * into a denial well before that, or the block arrives with a confusing timeout reason instead of a
 * decision.
 */
describe("escalating from a subagent to the parent", () => {
	test("the parent is asked and its answer is returned", async () => {
		registered.push("parent");
		registerSession("parent", {
			hasUI: true,
			notify: () => {},
			escalate: async () => "once",
		});
		expect(await requestParentEscalation("child-1", "bash", "risky", 1000)).toBe("once");
	});

	test("the parent sees the tool and the reason", async () => {
		const asked: string[] = [];
		registered.push("parent");
		registerSession("parent", {
			hasUI: true,
			notify: () => {},
			escalate: async (toolName, reason) => {
				asked.push(`${toolName}|${reason}`);
				return "deny";
			},
		});
		await requestParentEscalation("child-1", "write", "Adds an SSH key.", 1000);
		expect(asked[0]).toContain("write");
		expect(asked[0]).toContain("Adds an SSH key.");
	});

	test("allowing for the session is passed through", async () => {
		registered.push("parent");
		registerSession("parent", { hasUI: true, notify: () => {}, escalate: async () => "session" });
		expect(await requestParentEscalation("child-1", "bash", "risky", 1000)).toBe("session");
	});

	test("with no interactive session registered the answer is deny", async () => {
		expect(await requestParentEscalation("child-1", "bash", "risky", 1000)).toBe("deny");
	});

	test("a headless session is never asked, since nobody would see the prompt", async () => {
		let asked = false;
		registered.push("other-child");
		registerSession("other-child", {
			hasUI: false,
			notify: () => {},
			escalate: async () => {
				asked = true;
				return "once";
			},
		});
		expect(await requestParentEscalation("child-1", "bash", "risky", 1000)).toBe("deny");
		expect(asked).toBe(false);
	});

	test("the child is never asked to approve its own call", async () => {
		let asked = false;
		registered.push("child-1");
		registerSession("child-1", {
			hasUI: true,
			notify: () => {},
			escalate: async () => {
				asked = true;
				return "once";
			},
		});
		expect(await requestParentEscalation("child-1", "bash", "risky", 1000)).toBe("deny");
		expect(asked).toBe(false);
	});

	test("an unanswered prompt resolves to deny inside the budget", async () => {
		registered.push("parent");
		registerSession("parent", {
			hasUI: true,
			notify: () => {},
			escalate: () => Promise.withResolvers<never>().promise,
		});
		const started = Date.now();
		expect(await requestParentEscalation("child-1", "bash", "risky", 120)).toBe("deny");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("a prompt that throws resolves to deny", async () => {
		registered.push("parent");
		registerSession("parent", {
			hasUI: true,
			notify: () => {},
			escalate: async () => {
				throw new Error("ui is gone");
			},
		});
		expect(await requestParentEscalation("child-1", "bash", "risky", 1000)).toBe("deny");
	});

	test("a session without an escalate capability is skipped", async () => {
		registered.push("plain");
		registerSession("plain", { hasUI: true, notify: () => {} });
		expect(await requestParentEscalation("child-1", "bash", "risky", 1000)).toBe("deny");
	});

	test("only one parent is asked, so two sessions do not both prompt", async () => {
		let prompts = 0;
		for (const id of ["parent-a", "parent-b"]) {
			registered.push(id);
			registerSession(id, {
				hasUI: true,
				notify: () => {},
				escalate: async () => {
					prompts++;
					return "deny";
				},
			});
		}
		await requestParentEscalation("child-1", "bash", "risky", 1000);
		expect(prompts).toBe(1);
	});
});
