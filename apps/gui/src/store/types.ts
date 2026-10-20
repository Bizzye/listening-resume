import type { StateCreator } from "zustand";
import type { RecordingSlice } from "./slices/recording";
import type { SessionsSlice } from "./slices/sessions";
import type { SettingsSlice } from "./slices/settings";
import type { SystemSlice } from "./slices/system";
import type { TemplatesSlice } from "./slices/templates";
import type { ToastSlice } from "./slices/toasts";
import type { UiSlice } from "./slices/ui";

export type AppState = SettingsSlice &
	SystemSlice &
	SessionsSlice &
	RecordingSlice &
	TemplatesSlice &
	ToastSlice &
	UiSlice;

export type SliceCreator<T> = StateCreator<AppState, [], [], T>;
