
export const OMP_FAMILY = [
	"@oh-my-pi/pi-ai",
	"@oh-my-pi/pi-coding-agent",
	"@oh-my-pi/pi-utils",
	"omp-host",
	"omp-host-ai",
] as const;

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

type JsonObject = Record<string, unknown>;

export function validateOmpDependabot(packageJson: unknown, lockJson: unknown): string[] {
	const errors: string[] = [];
	if (!isObject(packageJson)) return ["package.json is not a JSON object"];
	if (!isObject(lockJson)) return ["bun.lock is not a JSON object"];
	const manifestDeps = nestedObject(packageJson, "devDependencies");
	const workspace = nestedObject(lockJson, "workspaces", "");
	const lockDeps = workspace && nestedObject(workspace, "devDependencies");
	const packages = nestedObject(lockJson, "packages");
	if (!manifestDeps) errors.push("package.json devDependencies is missing or malformed");
	if (!lockDeps) errors.push("bun.lock workspace devDependencies is missing or malformed");
	if (!packages) errors.push("bun.lock packages is missing or malformed");
	if (!manifestDeps || !lockDeps || !packages) return errors;

	const versions = new Map<string, string>();
	for (const name of OMP_FAMILY) {
		const manifestSpec = manifestDeps[name];
		const version = dependencyVersion(name, manifestSpec);
		if (!version) {
			errors.push(`${name} must be an exact semver in package.json devDependencies`);
			continue;
		}
		versions.set(name, version);
		if (lockDeps[name] !== manifestSpec) {
			errors.push(`${name} package.json and bun.lock specs differ`);
		}
		const lockEntry = packages[name];
		if (!Array.isArray(lockEntry) || typeof lockEntry[0] !== "string") {
			errors.push(`${name} is missing or malformed in bun.lock packages`);
			continue;
		}
		const lockedVersion = packageVersion(name, lockEntry[0]);
		if (lockedVersion !== version) {
			errors.push(`${name} bun.lock resolves ${lockedVersion ?? "an invalid version"}, expected ${version}`);
		}
	}
	if (versions.size === OMP_FAMILY.length) {
		const unique = new Set(versions.values());
		if (unique.size !== 1) errors.push("all OMP family members must resolve to one identical exact semver");
	}
	return errors;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedObject(value: JsonObject, ...keys: string[]): JsonObject | undefined {
	let current: unknown = value;
	for (const key of keys) {
		if (!isObject(current)) return undefined;
		current = current[key];
	}
	return isObject(current) ? current : undefined;
}

function dependencyVersion(name: string, spec: unknown): string | undefined {
	if (typeof spec !== "string") return undefined;
	if (EXACT_SEMVER.test(spec)) return spec;
	const alias = spec.match(new RegExp(`^npm:${escapeRegExp(name === "omp-host" ? "@oh-my-pi/pi-coding-agent" : name === "omp-host-ai" ? "@oh-my-pi/pi-ai" : name)}@(\\d+\\.\\d+\\.\\d+)$`));
	return alias?.[1];
}

function packageVersion(name: string, entry: string): string | undefined {
	const expectedPackage = name === "omp-host" ? "@oh-my-pi/pi-coding-agent" : name === "omp-host-ai" ? "@oh-my-pi/pi-ai" : name;
	const match = entry.match(new RegExp(`^${escapeRegExp(expectedPackage)}@(\\d+\\.\\d+\\.\\d+)$`));
	return match?.[1];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (Bun.argv[1]?.endsWith("validate-omp-dependabot.ts")) {
	const [packagePath = "package.json", lockPath = "bun.lock"] = Bun.argv.slice(2);
	try {
		const packageJson = Bun.JSON5.parse(await Bun.file(packagePath).text()) as unknown;
		const lockJson = Bun.JSON5.parse(await Bun.file(lockPath).text()) as unknown;
		const errors = validateOmpDependabot(packageJson, lockJson);
		if (errors.length > 0) {
			console.error(errors.join("\n"));
			process.exit(1);
		}
		console.log("OMP dependency family manifest and lockfile are valid");
	} catch (error) {
		console.error(`Unable to read or parse dependency files: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
