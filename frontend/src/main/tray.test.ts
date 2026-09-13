import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraySessionEntry } from "../shared/tray";

type MenuItem = {
	label?: string;
	sublabel?: string;
	enabled?: boolean;
	checked?: boolean;
	type?: string;
	role?: string;
	click?: () => void;
	submenu?: MenuItem[];
};

const { FakeTray, trayInstances } = vi.hoisted(() => {
	const trayInstances: FakeTray[] = [];
	class FakeTray {
		title = "";
		tooltip = "";
		template: MenuItem[] = [];
		destroyed = false;
		constructor(public icon: unknown) {
			trayInstances.push(this);
		}
		setTitle(title: string) {
			this.title = title;
		}
		setToolTip(tooltip: string) {
			this.tooltip = tooltip;
		}
		setContextMenu(menu: { template: MenuItem[] }) {
			this.template = menu.template;
		}
		destroy() {
			this.destroyed = true;
		}
	}
	return { FakeTray, trayInstances };
});

const setTemplateImage = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
	app: { isPackaged: false, getVersion: () => "0.0.0-test" },
	nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage }) },
	Tray: FakeTray,
	Menu: { buildFromTemplate: (template: MenuItem[]) => ({ template }) },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: () => true };
});

import { createTrayController } from "./tray";

function entry(overrides: Partial<TraySessionEntry> & { sessionId: string }): TraySessionEntry {
	return { projectId: "proj-1", projectName: "note-tauri", title: overrides.sessionId, zone: "action", ...overrides };
}

import type { UpdateSettings } from "./update-settings";

const NON_SESSION_CLICK_LABELS = new Set(["Show Agent Orchestrator", "Settings"]);

function setup(overrides?: { updateSettings?: UpdateSettings }) {
	const openSession = vi.fn();
	const focusWindow = vi.fn();
	const openSettings = vi.fn();
	const onThemeSelect = vi.fn();
	const onUpdateChannelSelect = vi.fn();
	const onUpdateEnabledToggle = vi.fn();
	const onCheckForUpdates = vi.fn();
	const updateSettings: UpdateSettings = overrides?.updateSettings ?? {
		enabled: false,
		channel: "latest",
		nightlyAck: false,
		feature: null,
	};
	const controller = createTrayController({
		focusWindow,
		openSession,
		openSettings,
		locale: "en",
		themePreference: "system",
		onThemeSelect,
		updateSettings,
		onUpdateChannelSelect,
		onUpdateEnabledToggle,
		onCheckForUpdates,
	});
	if (!controller) throw new Error("expected a tray controller");
	const tray = trayInstances[trayInstances.length - 1];
	return {
		controller,
		tray,
		openSession,
		focusWindow,
		openSettings,
		onThemeSelect,
		onUpdateChannelSelect,
		onUpdateEnabledToggle,
		onCheckForUpdates,
	};
}

const submenuOf = (tray: { template: MenuItem[] }, label: string) =>
	tray.template.find((item) => item.label === label)?.submenu ?? [];

const sessionItems = (tray: { template: MenuItem[] }) =>
	tray.template.filter(
		(item) => typeof item.click === "function" && !NON_SESSION_CLICK_LABELS.has(item.label ?? ""),
	);

afterEach(() => {
	trayInstances.length = 0;
	vi.clearAllMocks();
});

describe("createTrayController", () => {
	it("renders an empty state with no title before any session needs attention", () => {
		const { tray } = setup();
		expect(tray.title).toBe("");
		expect(tray.template.some((i) => i.label === "No sessions need attention" && i.enabled === false)).toBe(true);
		expect(tray.template.some((i) => i.role === "quit")).toBe(true);
	});

	it("uses grammatically correct singular for exactly one attention session", () => {
		const { controller, tray } = setup();
		controller.setState({ sessions: [entry({ sessionId: "s1", zone: "action" })] });
		expect(tray.tooltip).toBe("1 session needs attention");
	});

	it("shows the count and orders merge-ready sessions above needs-you", () => {
		const { controller, tray } = setup();
		controller.setState({
			sessions: [
				entry({ sessionId: "needs", title: "needs you", zone: "action" }),
				entry({ sessionId: "ready", title: "ready", zone: "merge" }),
			],
		});
		expect(tray.title).toBe("");
		expect(tray.tooltip).toBe("2 sessions need attention");
		const labels = tray.template.map((i) => i.label);
		expect(labels).toContain("Ready to merge");
		expect(labels).toContain("Needs you");
		expect(labels.indexOf("Ready to merge")).toBeLessThan(labels.indexOf("Needs you"));
		expect(sessionItems(tray).map((i) => i.label)).toEqual(["ready  ·  note-tauri", "needs you  ·  note-tauri"]);
	});

	it("hands a session click to the openSession delegate", () => {
		const { controller, tray, openSession } = setup();
		controller.setState({ sessions: [entry({ sessionId: "s1", title: "one" })] });
		sessionItems(tray)[0].click?.();
		expect(openSession).toHaveBeenCalledWith({ projectId: "proj-1", sessionId: "s1" });
	});

	it("marks the icon as a macOS template so the menu bar can tint it", () => {
		setup();
		expect(setTemplateImage).toHaveBeenCalledWith(true);
	});

	it("caps the menu and notes the overflow", () => {
		const { controller, tray } = setup();
		const many = Array.from({ length: 11 }, (_, i) => entry({ sessionId: `s${i}`, title: `s${i}` }));
		controller.setState({ sessions: many });
		expect(sessionItems(tray)).toHaveLength(8);
		const more = tray.template.find((i) => i.label?.startsWith("More"));
		expect(more?.submenu).toHaveLength(3);
	});

	it("clears back to the empty state", () => {
		const { controller, tray } = setup();
		controller.setState({ sessions: [entry({ sessionId: "s1" })] });
		expect(tray.tooltip).toBe("1 session needs attention");
		controller.clear();
		expect(tray.tooltip).toBe("Agent Orchestrator");
		expect(tray.template.some((i) => i.label === "No sessions need attention")).toBe(true);
	});

	it("destroys the tray on dispose", () => {
		const { controller, tray } = setup();
		controller.dispose();
		expect(tray.destroyed).toBe(true);
	});

	it("relocalizes menu labels when setLocale is called", () => {
		const { controller, tray } = setup();
		controller.setState({ sessions: [entry({ sessionId: "s1", zone: "action" })] });
		expect(tray.template.some((i) => i.label === "Needs you")).toBe(true);

		controller.setLocale("zh-CN");
		expect(tray.tooltip).toBe("1 个会话需要关注");
		expect(tray.template.some((i) => i.label === "需要你处理")).toBe(true);
		expect(tray.template.some((i) => i.label === "显示 Agent Orchestrator")).toBe(true);
	});

	it("never paints a numeric badge on the icon, even with attention sessions", () => {
		const { controller, tray } = setup();
		expect(tray.title).toBe("");
		controller.setState({
			sessions: [entry({ sessionId: "a" }), entry({ sessionId: "b" })],
		});
		expect(tray.title).toBe("");
	});

	it("offers a Theme submenu that checks the active preference and delegates a change", () => {
		const { controller, tray, onThemeSelect } = setup();
		const theme = submenuOf(tray, "Theme");
		expect(theme.map((i) => i.label)).toEqual(["System", "Light", "Dark"]);
		expect(theme.find((i) => i.label === "System")?.checked).toBe(true);
		theme.find((i) => i.label === "Dark")?.click?.();
		expect(onThemeSelect).toHaveBeenCalledWith("dark");

		controller.setThemePreference("dark");
		const afterChange = submenuOf(tray, "Theme");
		expect(afterChange.find((i) => i.label === "Dark")?.checked).toBe(true);
		expect(afterChange.find((i) => i.label === "System")?.checked).toBe(false);
	});

	it("offers an Updates submenu reflecting channel and auto-check state", () => {
		const { controller, tray, onUpdateChannelSelect, onUpdateEnabledToggle, onCheckForUpdates } = setup({
			updateSettings: { enabled: true, channel: "nightly", nightlyAck: true, feature: null },
		});
		const updates = submenuOf(tray, "Updates");
		expect(updates.find((i) => i.label === "Nightly")?.checked).toBe(true);
		expect(updates.find((i) => i.label === "Stable")?.checked).toBe(false);
		expect(updates.find((i) => i.label === "Automatic updates")?.checked).toBe(true);

		updates.find((i) => i.label === "Stable")?.click?.();
		expect(onUpdateChannelSelect).toHaveBeenCalledWith("latest");
		updates.find((i) => i.label === "Automatic updates")?.click?.();
		expect(onUpdateEnabledToggle).toHaveBeenCalledWith(false);
		updates.find((i) => i.label === "Check for updates")?.click?.();
		expect(onCheckForUpdates).toHaveBeenCalled();

		controller.setUpdateSettings({ enabled: false, channel: "latest", nightlyAck: false, feature: null });
		const after = submenuOf(tray, "Updates");
		expect(after.find((i) => i.label === "Stable")?.checked).toBe(true);
		expect(after.find((i) => i.label === "Automatic updates")?.checked).toBe(false);
	});

	it("hands the Settings entry to the openSettings delegate", () => {
		const { tray, openSettings } = setup();
		tray.template.find((i) => i.label === "Settings")?.click?.();
		expect(openSettings).toHaveBeenCalled();
	});
});
