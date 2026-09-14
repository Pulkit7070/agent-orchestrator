// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	AO_BUNDLE_ID,
	findStaleAppCopies,
	isUnchangedStaleAppCopy,
	readBundleMetadata,
	retireStaleAppCopies,
	retireStaleMacAppCopies,
	type BundleMetadata,
	type StaleAppCopy,
} from "./stale-app-copies";

const RUNNING_PATH = "/Applications/Agent Orchestrator.app";
const RUNNING_VERSION = "0.13.1-nightly.202609121623";
const DOWNLOADS_COPY = "/Users/user/Downloads/Agent Orchestrator.app";
const DESKTOP_COPY = "/Users/user/Desktop/Agent Orchestrator.app";
const ORIGINAL_IDENTITY = { device: 1, inode: 10 };

describe("readBundleMetadata", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("reads the exact identifier and version from Info.plist", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "ao-stale-copy-"));
		temporaryDirectories.push(directory);
		const bundle = path.join(directory, "Agent Orchestrator.app");
		await mkdir(path.join(bundle, "Contents"), { recursive: true });
		await writeFile(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleIdentifier</key><string>${AO_BUNDLE_ID}</string>
<key>CFBundleShortVersionString</key><string>0.10.3</string>
</dict></plist>`);

		await expect(readBundleMetadata(bundle)).resolves.toEqual({
			bundleId: AO_BUNDLE_ID,
			version: "0.10.3",
		});
	});
});

describe("findStaleAppCopies", () => {
	function dependencies(options: {
		identities?: Record<string, { device: number; inode: number } | null>;
		metadata?: Record<string, BundleMetadata>;
	} = {}) {
		return {
			fileIdentity: vi.fn(async (candidate: string) => options.identities?.[candidate] ?? null),
			readMetadata: vi.fn(async (candidate: string) => {
				const metadata = options.metadata?.[candidate];
				if (!metadata) throw new Error("unreadable");
				return metadata;
			}),
		};
	}

	it("finds valid older AO copies only in Downloads and Desktop", async () => {
		const deps = dependencies({
			identities: {
				[DOWNLOADS_COPY]: ORIGINAL_IDENTITY,
				[DESKTOP_COPY]: { device: 1, inode: 11 },
			},
			metadata: {
				[DOWNLOADS_COPY]: { bundleId: AO_BUNDLE_ID, version: "0.10.3" },
				[DESKTOP_COPY]: { bundleId: AO_BUNDLE_ID, version: "0.12.0" },
			},
		});

		await expect(findStaleAppCopies({
			runningVersion: RUNNING_VERSION,
			homeDir: "/Users/user",
		}, deps)).resolves.toEqual([
			{ path: DOWNLOADS_COPY, version: "0.10.3", ...ORIGINAL_IDENTITY },
			{ path: DESKTOP_COPY, version: "0.12.0", device: 1, inode: 11 },
		]);
		expect(deps.fileIdentity).toHaveBeenCalledTimes(2);
	});

	it.each([
		["another app", ORIGINAL_IDENTITY, { bundleId: "com.example.other", version: "0.10.3" }],
		["an unreadable version", ORIGINAL_IDENTITY, { bundleId: AO_BUNDLE_ID, version: null }],
		["an invalid version", ORIGINAL_IDENTITY, { bundleId: AO_BUNDLE_ID, version: "broken" }],
		["the same version", ORIGINAL_IDENTITY, { bundleId: AO_BUNDLE_ID, version: RUNNING_VERSION }],
		["a newer version", ORIGINAL_IDENTITY, { bundleId: AO_BUNDLE_ID, version: "0.14.0" }],
		["a symlink or regular file", null, { bundleId: AO_BUNDLE_ID, version: "0.10.3" }],
	] as const)("leaves %s untouched", async (_label, identity, metadata) => {
		const deps = dependencies({
			identities: { [DOWNLOADS_COPY]: identity },
			metadata: { [DOWNLOADS_COPY]: metadata },
		});

		await expect(findStaleAppCopies({
			runningVersion: RUNNING_VERSION,
			homeDir: "/Users/user",
		}, deps)).resolves.toEqual([]);
	});

	it("does nothing when the running version is invalid", async () => {
		const deps = dependencies();
		await expect(findStaleAppCopies({
			runningVersion: "development",
			homeDir: "/Users/user",
		}, deps)).resolves.toEqual([]);
		expect(deps.fileIdentity).not.toHaveBeenCalled();
	});
});

describe("retireStaleAppCopies", () => {
	const stale: StaleAppCopy = {
		path: DOWNLOADS_COPY,
		version: "0.10.3",
		...ORIGINAL_IDENTITY,
	};

	it("requires confirmation before moving a copy to Trash", async () => {
		const trashItem = vi.fn(async () => undefined);
		await retireStaleAppCopies({
			findCopies: async () => [stale],
			confirm: async () => false,
			revalidate: async () => true,
			trashItem,
			reportFailures: vi.fn(),
		});
		expect(trashItem).not.toHaveBeenCalled();
	});

	it("reports a copy that macOS could not move to Trash", async () => {
		const reportFailures = vi.fn(async () => undefined);
		await retireStaleAppCopies({
			findCopies: async () => [stale],
			confirm: async () => true,
			revalidate: async () => true,
			trashItem: async () => { throw new Error("denied"); },
			reportFailures,
		});
		expect(reportFailures).toHaveBeenCalledWith([DOWNLOADS_COPY]);
	});

	it("leaves a replacement untouched when the path changes while confirmation is open", async () => {
		let approve: (() => void) | undefined;
		let markConfirmStarted: (() => void) | undefined;
		const confirmStarted = new Promise<void>((resolve) => {
			markConfirmStarted = resolve;
		});
		const confirm = new Promise<boolean>((resolve) => {
			approve = () => resolve(true);
		});
		let identity = ORIGINAL_IDENTITY;
		const dependencies = {
			fileIdentity: async () => identity,
			readMetadata: async () => ({ bundleId: AO_BUNDLE_ID, version: "0.10.3" }),
		};
		const trashItem = vi.fn(async () => undefined);
		const retirement = retireStaleAppCopies({
			findCopies: async () => [stale],
			confirm: async () => {
				markConfirmStarted?.();
				return confirm;
			},
			revalidate: (copy) => isUnchangedStaleAppCopy(copy, RUNNING_VERSION, dependencies),
			trashItem,
			reportFailures: vi.fn(),
		});

		await confirmStarted;
		identity = { device: 1, inode: 99 };
		approve?.();
		await retirement;

		expect(trashItem).not.toHaveBeenCalled();
	});
});

describe("retireStaleMacAppCopies", () => {
	function runtime(overrides: Record<string, unknown> = {}) {
		return {
			platform: "darwin",
			isPackaged: true,
			runningPath: RUNNING_PATH,
			runningVersion: RUNNING_VERSION,
			findCopies: vi.fn(async () => []),
			confirm: vi.fn(async () => false),
			trashItem: vi.fn(async () => undefined),
			reportFailures: vi.fn(async () => undefined),
			...overrides,
		};
	}

	it.each([
		{ platform: "linux" },
		{ isPackaged: false },
		{ runningPath: DOWNLOADS_COPY },
		{ runningVersion: "development" },
	])("does not inspect files outside the maintained packaged macOS app: %o", async (override) => {
		const options = runtime(override);
		await retireStaleMacAppCopies(options);
		expect(options.findCopies).not.toHaveBeenCalled();
	});

	it("checks once after the maintained packaged macOS app starts", async () => {
		const options = runtime();
		await retireStaleMacAppCopies(options);
		expect(options.findCopies).toHaveBeenCalledOnce();
	});
});
