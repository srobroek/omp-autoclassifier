import { describe, expect, test } from "bun:test";
import { VerdictCache } from "../src/cache";

describe("VerdictCache", () => {
	test("an allowed call is remembered", () => {
		const cache = new VerdictCache(10);
		const input = { command: "git status" };
		expect(cache.isAllowed("bash", input)).toBe(false);
		cache.allow("bash", input);
		expect(cache.isAllowed("bash", input)).toBe(true);
	});

	test("argument key order does not change identity", () => {
		const cache = new VerdictCache(10);
		cache.allow("edit", { path: "a.ts", content: "x" });
		expect(cache.isAllowed("edit", { content: "x", path: "a.ts" })).toBe(true);
	});

	test("nested argument key order does not change identity", () => {
		const cache = new VerdictCache(10);
		cache.allow("t", { outer: { b: 1, a: [{ y: 2, x: 1 }] } });
		expect(cache.isAllowed("t", { outer: { a: [{ x: 1, y: 2 }], b: 1 } })).toBe(true);
	});

	test("array order is significant, unlike key order", () => {
		const cache = new VerdictCache(10);
		cache.allow("t", { list: [1, 2] });
		expect(cache.isAllowed("t", { list: [2, 1] })).toBe(false);
	});

	test("a different argument is a different decision", () => {
		const cache = new VerdictCache(10);
		cache.allow("bash", { command: "git status" });
		expect(cache.isAllowed("bash", { command: "git push" })).toBe(false);
	});

	test("the same argument under a different tool is a different decision", () => {
		const cache = new VerdictCache(10);
		cache.allow("read", { path: "x" });
		expect(cache.isAllowed("write", { path: "x" })).toBe(false);
	});

	test("only allows can be recorded, so a denial re-classifies after the user authorizes it", () => {
		const cache = new VerdictCache(10);
		const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(new VerdictCache(1)));
		expect(surface).not.toContain("deny");
		expect(surface.some(name => /den/i.test(name))).toBe(false);
		expect(cache.isAllowed("bash", { command: "rm -rf /" })).toBe(false);
	});

	test("the cache is capped and evicts the least recently used entry", () => {
		const cache = new VerdictCache(2);
		cache.allow("bash", { command: "a" });
		cache.allow("bash", { command: "b" });
		cache.allow("bash", { command: "c" });
		expect(cache.size).toBe(2);
		expect(cache.isAllowed("bash", { command: "a" })).toBe(false);
		expect(cache.isAllowed("bash", { command: "b" })).toBe(true);
		expect(cache.isAllowed("bash", { command: "c" })).toBe(true);
	});

	test("a hit refreshes recency, sparing an entry that would otherwise be evicted", () => {
		const cache = new VerdictCache(2);
		cache.allow("bash", { command: "a" });
		cache.allow("bash", { command: "b" });
		expect(cache.isAllowed("bash", { command: "a" })).toBe(true);
		cache.allow("bash", { command: "c" });
		expect(cache.isAllowed("bash", { command: "a" })).toBe(true);
		expect(cache.isAllowed("bash", { command: "b" })).toBe(false);
	});

	test("re-allowing an existing entry does not grow the cache", () => {
		const cache = new VerdictCache(5);
		cache.allow("bash", { command: "a" });
		cache.allow("bash", { command: "a" });
		expect(cache.size).toBe(1);
	});

	test("clear drops every remembered allow", () => {
		const cache = new VerdictCache(10);
		cache.allow("bash", { command: "a" });
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.isAllowed("bash", { command: "a" })).toBe(false);
	});

	test("a zero capacity disables caching entirely", () => {
		const cache = new VerdictCache(0);
		cache.allow("bash", { command: "a" });
		expect(cache.size).toBe(0);
		expect(cache.isAllowed("bash", { command: "a" })).toBe(false);
	});

	test("unserializable input is never cached rather than colliding", () => {
		const cache = new VerdictCache(10);
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		cache.allow("bash", cyclic);
		expect(cache.isAllowed("bash", cyclic)).toBe(false);
		expect(cache.size).toBe(0);
	});
});
