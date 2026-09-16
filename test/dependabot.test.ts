import { describe, expect, test } from "bun:test";
import { OMP_FAMILY, validateOmpDependabot } from "../tools/validate-omp-dependabot";

const version = "18.2.1";

function fixture(overrides: {
	manifest?: Record<string, unknown>;
	lockDeps?: Record<string, unknown>;
	lockPackages?: Record<string, unknown>;
} = {}) {
	const manifest = Object.fromEntries(OMP_FAMILY.map((name) => [name, name === "omp-host" ? `npm:@oh-my-pi/pi-coding-agent@${version}` : name === "omp-host-ai" ? `npm:@oh-my-pi/pi-ai@${version}` : version]));
	const lockDeps = { ...manifest };
	const lockPackages = Object.fromEntries(OMP_FAMILY.map((name) => [name, [`${name === "omp-host" ? "@oh-my-pi/pi-coding-agent" : name === "omp-host-ai" ? "@oh-my-pi/pi-ai" : name}@${version}`]]));
	return {
		packageJson: { devDependencies: { ...manifest, ...overrides.manifest } },
		lockJson: { workspaces: { "": { devDependencies: { ...lockDeps, ...overrides.lockDeps } } }, packages: { ...lockPackages, ...overrides.lockPackages } },
	};
}

describe("OMP Dependabot dependency policy", () => {
	test("accepts the complete family at one exact version", () => {
		expect(validateOmpDependabot(...Object.values(fixture()) as [unknown, unknown])).toEqual([]);
	});

	test("rejects a partial family", () => {
		const { packageJson, lockJson } = fixture();
		delete (packageJson.devDependencies as Record<string, unknown>)["omp-host-ai"];
		expect(validateOmpDependabot(packageJson, lockJson).join("\n")).toContain("omp-host-ai");
	});

	test("rejects mixed manifest versions", () => {
		const { packageJson, lockJson } = fixture({ manifest: { "@oh-my-pi/pi-utils": "18.2.2" } });
		expect(validateOmpDependabot(packageJson, lockJson).join("\n")).toContain("identical exact semver");
	});

	test("rejects a stale or mixed lockfile", () => {
		const { packageJson, lockJson } = fixture({ lockPackages: { "@oh-my-pi/pi-ai": ["@oh-my-pi/pi-ai@18.2.0"] } });
		expect(validateOmpDependabot(packageJson, lockJson).join("\n")).toContain("bun.lock resolves 18.2.0");
	});

	test("rejects malformed or missing dependency data", () => {
		expect(validateOmpDependabot({}, {})).toEqual([
			"package.json devDependencies is missing or malformed",
			"bun.lock workspace devDependencies is missing or malformed",
			"bun.lock packages is missing or malformed",
		]);
	});
});
