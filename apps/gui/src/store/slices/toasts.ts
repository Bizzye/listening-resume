import type { SliceCreator } from "../types";

export type ToastKind = "ok" | "ac" | "err";

export interface Toast {
	id: number;
	msg: string;
	kind: ToastKind;
}

export interface ToastSlice {
	toast: Toast | null;
	pop: (msg: string, kind?: ToastKind) => void;
	dismissToast: () => void;
}

export const TOAST_MS = 2800;

let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

export const createToastSlice: SliceCreator<ToastSlice> = (set) => ({
	toast: null,
	pop: (msg, kind = "ok") => {
		clearTimeout(timer);
		seq += 1;
		set({ toast: { id: seq, msg, kind } });
		timer = setTimeout(() => set({ toast: null }), TOAST_MS);
	},
	dismissToast: () => {
		clearTimeout(timer);
		set({ toast: null });
	},
});
