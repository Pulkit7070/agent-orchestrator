import type { WorkspaceFileSummary } from "../hooks/useSessionWorkspaceFiles";

function normalizeWorkspacePath(path: string): string {
	return path.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

function fileBasename(path: string): string {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Map a chat/turn path onto the workspace-relative path the Files API expects.
 * Turn diffs often carry basenames or absolute worktree paths; the workspace
 * file list carries repo-relative paths.
 */
export function matchWorkspaceFilePath(
	rawPath: string,
	files: readonly WorkspaceFileSummary[],
): string {
	const normalized = normalizeWorkspacePath(rawPath);
	if (!normalized) return rawPath;

	const exact =
		files.find((file) => file.path === rawPath) ??
		files.find((file) => file.path === normalized);
	if (exact) return exact.path;

	// The input already contains the workspace-relative path as a tail: an absolute
	// worktree path (`/…/worktrees/demo/frontend/index.ts`) or a path with extra
	// leading segments. Prefer the longest matching entry so a deeper repo-qualified
	// path wins over a bare basename. The longest tail of a fixed string is unique,
	// so this never has to guess between two same-length candidates.
	const inputTail = files
		.filter((file) => normalized.endsWith(`/${file.path}`))
		.sort((a, b) => b.path.length - a.path.length);
	if (inputTail.length > 0) return inputTail[0]!.path;

	const suffix = files.find(
		(file) => file.path.endsWith(`/${normalized}`) || file.path.endsWith(`/${rawPath}`),
	);
	if (suffix) return suffix.path;

	const base = fileBasename(normalized);
	const byBase = files.filter((file) => fileBasename(file.path) === base);
	if (byBase.length === 1) return byBase[0]!.path;

	return normalized;
}
