import { fileChangeFiles, type ConversationItem } from "../types/conversation";

/**
 * Absolute paths and a worktree cwd gathered from the same turn's activities, so a
 * turn-diff basename can be shown like the Edited tooltip. Each basename keeps every
 * distinct absolute candidate seen in the turn (not a single value collapsed to
 * `undefined` on the first collision), so a row that carries directory segments can
 * be matched to the right repo instead of dropping its hint entirely.
 */
export type TurnPathHints = {
	byBase: Map<string, string[]>;
	cwd?: string;
};

function fileBasename(path: string): string {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return slash >= 0 ? path.slice(slash + 1) : path;
}

export function looksAbsolutePath(path: string): boolean {
	return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path);
}

function rememberTurnPathHint(byBase: Map<string, string[]>, absolutePath: string) {
	const base = fileBasename(absolutePath);
	const candidates = byBase.get(base);
	if (!candidates) {
		byBase.set(base, [absolutePath]);
		return;
	}
	if (!candidates.includes(absolutePath)) candidates.push(absolutePath);
}

/**
 * The single turn candidate whose absolute path ends with the row's whole relative
 * path. Matching the full relative suffix, not just the basename, keeps a row like
 * `src/a.ts` from binding to an unrelated `.../other/a.ts`, and lets two rows that
 * carry directory segments (`alpha/x.txt`, `beta/x.txt`) each resolve to their own
 * repo. Returns undefined when nothing matches or the row is genuinely ambiguous
 * (e.g. two bare `x.txt` rows against candidates in two repos), so the caller can
 * fall back to the row's own path rather than guess.
 */
function matchTurnCandidate(relPath: string, hints: TurnPathHints): string | undefined {
	const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
	const candidates = hints.byBase.get(fileBasename(rel));
	if (!candidates?.length) return undefined;
	const matches = candidates.filter((candidate) => {
		const normalized = candidate.replace(/\\/g, "/");
		return normalized === rel || normalized.endsWith(`/${rel}`);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

export function turnPathHints(items: ConversationItem[] | undefined): TurnPathHints {
	const byBase = new Map<string, string[]>();
	let cwd: string | undefined;
	if (!items?.length) return { byBase, cwd };

	for (const item of items) {
		if (item.kind !== "activity") continue;
		if (!cwd && item.detail?.cwd) cwd = item.detail.cwd;
		if (item.activityKind !== "file_change") continue;
		for (const file of fileChangeFiles(item)) {
			if (looksAbsolutePath(file.path)) rememberTurnPathHint(byBase, file.path);
			if (file.oldPath && looksAbsolutePath(file.oldPath)) rememberTurnPathHint(byBase, file.oldPath);
		}
	}
	return { byBase, cwd };
}

/** Prefer an absolute path from the turn; otherwise join the worktree cwd. */
export function resolveTurnFilePath(path: string, hints: TurnPathHints): string {
	if (looksAbsolutePath(path)) return path;
	const matched = matchTurnCandidate(path, hints);
	if (matched) return matched;
	if (hints.cwd) {
		const rel = path.replace(/^\.\//, "");
		return `${hints.cwd.replace(/\/$/, "")}/${rel}`;
	}
	return path;
}

/** Longest shared leading directory of two absolute paths (`""` if none). */
function commonDirPrefix(a: string, b: string): string {
	const aSegments = a.split("/");
	const bSegments = b.split("/");
	const shared: string[] = [];
	const limit = Math.min(aSegments.length, bSegments.length);
	for (let i = 0; i < limit; i++) {
		if (aSegments[i] !== bSegments[i]) break;
		shared.push(aSegments[i]!);
	}
	return shared.join("/");
}

/**
 * Strip the worktree root and keep enough suffix to disambiguate duplicate basenames.
 * The cwd is often a subdirectory of the worktree (an agent runs a command in
 * `frontend/` then edits `backend/x.ts`), so anchor on the deepest directory the file
 * and the cwd share rather than requiring the file to sit under the cwd: that keeps
 * `backend/x.ts` instead of collapsing to `x.ts`, while never prefixing a segment that
 * is not already in the path. Without a cwd to anchor against there is no reliable
 * workspace prefix, so fall back to the basename rather than inventing a qualifier.
 */
export function workspaceRelativeOpenPath(absolutePath: string, cwd?: string): string {
	const normalized = absolutePath.replace(/\\/g, "/");
	if (cwd) {
		const root = commonDirPrefix(normalized, cwd.replace(/\\/g, "/").replace(/\/$/, ""));
		if (root && normalized.startsWith(`${root}/`)) {
			return normalized.slice(root.length + 1);
		}
	}
	return fileBasename(normalized);
}

/** Workspace-relative path to open in the Files panel from a turn diff row. */
export function turnFileOpenPath(path: string, hints: TurnPathHints): string {
	const normalized = path.replace(/^\.\//, "");
	if (!looksAbsolutePath(normalized)) {
		const matched = matchTurnCandidate(normalized, hints);
		if (matched) {
			// With no root to strip the hint collapses to a basename; never hand back
			// less qualification than the row already carried (`src/a.ts` -> `a.ts`).
			const open = workspaceRelativeOpenPath(matched, hints.cwd);
			return open.includes("/") || !normalized.includes("/") ? open : normalized;
		}
		return normalized;
	}
	return workspaceRelativeOpenPath(normalized, hints.cwd);
}
