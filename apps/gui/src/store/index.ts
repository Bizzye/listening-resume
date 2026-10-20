import { create } from "zustand";
import { createRecordingSlice } from "./slices/recording";
import { createSessionsSlice } from "./slices/sessions";
import { createSettingsSlice } from "./slices/settings";
import { createSystemSlice } from "./slices/system";
import { createTemplatesSlice } from "./slices/templates";
import { createToastSlice } from "./slices/toasts";
import { createUiSlice } from "./slices/ui";
import type { AppState } from "./types";

export const useStore = create<AppState>()((...a) => ({
	...createSettingsSlice(...a),
	...createSystemSlice(...a),
	...createSessionsSlice(...a),
	...createRecordingSlice(...a),
	...createTemplatesSlice(...a),
	...createToastSlice(...a),
	...createUiSlice(...a),
}));

export type { AppState } from "./types";
