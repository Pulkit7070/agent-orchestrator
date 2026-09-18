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
 * fall back to the row's own path rather than guess. Candidates are always absolute
 * (they only enter `byBase` behind `looksAbsolutePath`) and every caller reaches
 * here only after an absolute-path early return, so `rel` is always relative and a
 * bare equality check would be dead code: the suffix test is sufficient.
 */
function matchTurnCandidate(relPath: string, hints: TurnPathHints): string | undefined {
	const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
	const candidates = hints.byBase.get(fileBasename(rel));
	if (!candidates?.length) return undefined;
	const matches = candidates.filter((candidate) =>
		candidate.replace(/\\/g, "/").endsWith(`/${rel}`),
	);
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
