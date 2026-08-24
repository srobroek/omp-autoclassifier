import { afterEach, describe, expect, test } from "bun:test";
import { registerSession, reportChildDenial, unregisterSession } from "../src/registry";

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
