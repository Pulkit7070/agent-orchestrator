import { describe, expect, it } from "vitest";
import { turnFileOpenPath, turnPathHints, workspaceRelativeOpenPath } from "./turn-file-open-path";

const cwd = "/Users/me/.ao/dev/data/worktrees/demo/demo-1";

function fileChangeActivity(path: string) {
	return {
		kind: "activity" as const,
		id: `a-${path}`,
		sequence: 1,
		revision: 0,
		activityKind: "file_change" as const,
		status: "completed" as const,
		summary: "Edited 1 file",
		detail: {
			files: [{ path, status: "added" as const, additions: 1, deletions: 0 }],
		},
		createdAt: new Date().toISOString(),
	};
}

describe("workspaceRelativeOpenPath", () => {
	it("strips the worktree cwd and keeps nested path segments", () => {
		expect(workspaceRelativeOpenPath(`${cwd}/frontend/index.ts`, cwd)).toBe("frontend/index.ts");
		expect(workspaceRelativeOpenPath(`${cwd}/backend/index.ts`, cwd)).toBe("backend/index.ts");
	});

	it("falls back to the basename when cwd is missing", () => {
		// Without a cwd the leading segments are the worktree directory
		// (`.../worktrees/demo/demo-1`), not workspace path, so a `slice(-2)`
		// prefix would name a directory that does not exist in the workspace.
		expect(
			workspaceRelativeOpenPath("/Users/me/.ao/dev/data/worktrees/demo/demo-1/frontend/index.ts"),
		).toBe("index.ts");
	});

	it("anchors on the shared worktree dir when cwd is a subdirectory", () => {
		// The recorded cwd is a subdirectory the agent ran a command in; the edited
		// file lives elsewhere in the same worktree. Strip the shared root so the
		// sibling segment survives instead of collapsing to the basename.
		expect(workspaceRelativeOpenPath(`${cwd}/backend/x.ts`, `${cwd}/frontend`)).toBe(
			"backend/x.ts",
		);
	});
});

describe("turnFileOpenPath", () => {
	it("passes through an already workspace-relative path", () => {
		expect(turnFileOpenPath("src/a.ts", { byBase: new Map() })).toBe("src/a.ts");
	});

	it("preserves duplicate-disambiguating suffixes for relative paths", () => {
		const hints = { byBase: new Map(), cwd };
		expect(turnFileOpenPath("frontend/index.ts", hints)).toBe("frontend/index.ts");
		expect(turnFileOpenPath("backend/index.ts", hints)).toBe("backend/index.ts");
	});

	it("converts an absolute turn diff path using the worktree cwd", () => {
		const hints = { byBase: new Map(), cwd };
		expect(turnFileOpenPath(`${cwd}/frontend/index.ts`, hints)).toBe("frontend/index.ts");
		expect(turnFileOpenPath(`${cwd}/backend/index.ts`, hints)).toBe("backend/index.ts");
	});

	it("matches on the whole relative path, not just the basename", () => {
		// A row `src/a.ts` must not bind to an unrelated `.../other/a.ts` that only
		// shares the basename: the hint's suffix has to line up with the row.
		const hints = turnPathHints([
			fileChangeActivity(`${cwd}/other/a.ts`),
		]);
		expect(turnFileOpenPath("src/a.ts", hints)).toBe("src/a.ts");
	});

	it("keeps a row's own segments when a matched hint has no cwd to strip", () => {
		// The hint matches but there is no cwd anchor, so trimming it yields only the
		// basename. That is less than the row already carried, so keep the row path.
		const hints = turnPathHints([fileChangeActivity(`${cwd}/src/a.ts`)]);
		expect(hints.cwd).toBeUndefined();
		expect(turnFileOpenPath("src/a.ts", hints)).toBe("src/a.ts");
	});

	it("resolves a bare row against a hint edited outside the recorded cwd", () => {
		// cwd is a subdirectory; the hint lives in a sibling directory of the worktree.
		const hints = { ...turnPathHints([fileChangeActivity(`${cwd}/backend/x.ts`)]), cwd: `${cwd}/frontend` };
		expect(turnFileOpenPath("x.ts", hints)).toBe("backend/x.ts");
	});

	it("resolves each subdir-qualified row to its own repo when basenames collide", () => {
		// Two repos in one workspace change a file of the same name. Rows that carry
		// the repo subdir each resolve to their own candidate instead of collapsing.
		const hints = {
			...turnPathHints([
				fileChangeActivity(`${cwd}/alpha/workspace-test.txt`),
				fileChangeActivity(`${cwd}/beta/workspace-test.txt`),
			]),
			cwd,
		};
		expect(turnFileOpenPath("alpha/workspace-test.txt", hints)).toBe("alpha/workspace-test.txt");
		expect(turnFileOpenPath("beta/workspace-test.txt", hints)).toBe("beta/workspace-test.txt");
	});

	it("leaves a bare row unqualified when candidates are genuinely ambiguous", () => {
		// Two same-named files in different repos, but the row carries no subdir to
		// tell them apart. Guessing one would name the wrong file, so keep it bare.
		const hints = {
			...turnPathHints([
				fileChangeActivity(`${cwd}/alpha/workspace-test.txt`),
				fileChangeActivity(`${cwd}/beta/workspace-test.txt`),
			]),
			cwd,
		};
		expect(turnFileOpenPath("workspace-test.txt", hints)).toBe("workspace-test.txt");
	});

	it("resolves a basename hint from the turn's file_change activity", () => {
		// The worktree cwd is what lets the absolute hint be trimmed back to a
		// workspace-relative `docs/notes.txt` rather than just the basename.
		const hints = { ...turnPathHints([fileChangeActivity(`${cwd}/docs/notes.txt`)]), cwd };
		expect(turnFileOpenPath("notes.txt", hints)).toBe("docs/notes.txt");
	});
});
