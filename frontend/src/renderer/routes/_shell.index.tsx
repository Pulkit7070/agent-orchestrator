import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { MigrationPopup } from "../components/MigrationPopup";
import { SessionsBoard } from "../components/SessionsBoard";
import { useWorkspaceRootRedirect } from "../hooks/useWorkspaceQuery";

export const Route = createFileRoute("/_shell/")({
	component: ShellIndex,
});

function ShellIndex() {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceRootRedirect();

	useEffect(() => {
		if (!workspaceQuery.isSuccess) return;
		const workspace = workspaceQuery.data;
		if (!workspace) return;
		if (workspace.id !== "scratch" || workspace.kind !== "scratch") return;
		void navigate({
			to: "/projects/$projectId",
			params: { projectId: "scratch" },
			replace: true,
		});
	}, [navigate, workspaceQuery.data, workspaceQuery.isSuccess]);

	return (
		<>
			<MigrationPopup />
			<SessionsBoard />
		</>
	);
}
