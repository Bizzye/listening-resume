import type { SliceCreator } from "../types";

export type Screen = "dash" | "sessions" | "detail" | "templates" | "settings";
export type DetailTab = "t" | "a" | "e";
export type BootState = "loading" | "ready" | "error";

export type TemplateEditorState = { mode: "new" } | { mode: "edit"; id: string } | null;

export interface UiSlice {
	boot: BootState;
	screen: Screen;
	detailId: string | null;
	detailTab: DetailTab;
	/** Set when the detail should open with the title in edit mode (quick menu "Renomear"). */
	editTitleOnOpen: boolean;
	deleteId: string | null;
	templateEditor: TemplateEditorState;
	/** Selected template in the analysis tab (null = settings.defaultTemplateId). */
	selectedTemplateId: string | null;
	/** Active analysis chip per session. */
	activeAnalysis: Record<string, string>;
	setBoot: (b: BootState) => void;
	go: (screen: Screen) => void;
	openSession: (id: string, tab?: DetailTab, opts?: { editTitle?: boolean }) => void;
	setDetailTab: (tab: DetailTab) => void;
	consumeEditTitle: () => boolean;
	askDelete: (id: string) => void;
	cancelDelete: () => void;
	openTemplateEditor: (state: Exclude<TemplateEditorState, null>) => void;
	closeTemplateEditor: () => void;
	selectTemplate: (id: string) => void;
	setActiveAnalysis: (sessionId: string, analysisId: string) => void;
}

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
	boot: "loading",
	screen: "dash",
	detailId: null,
	detailTab: "t",
	editTitleOnOpen: false,
	deleteId: null,
	templateEditor: null,
	selectedTemplateId: null,
	activeAnalysis: {},
	setBoot: (boot) => set({ boot }),
	go: (screen) => set({ screen }),
	openSession: (id, tab = "t", opts) =>
		set({ screen: "detail", detailId: id, detailTab: tab, editTitleOnOpen: !!opts?.editTitle }),
	setDetailTab: (detailTab) => set({ detailTab }),
	consumeEditTitle: () => {
		const v = get().editTitleOnOpen;
		if (v) set({ editTitleOnOpen: false });
		return v;
	},
	askDelete: (deleteId) => set({ deleteId }),
	cancelDelete: () => set({ deleteId: null }),
	openTemplateEditor: (templateEditor) => set({ templateEditor }),
	closeTemplateEditor: () => set({ templateEditor: null }),
	selectTemplate: (selectedTemplateId) => set({ selectedTemplateId }),
	setActiveAnalysis: (sessionId, analysisId) =>
		set((s) => ({ activeAnalysis: { ...s.activeAnalysis, [sessionId]: analysisId } })),
});
