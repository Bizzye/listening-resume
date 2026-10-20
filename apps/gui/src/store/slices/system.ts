import { api, errorMessage } from "../../shared/api/client";
import type { AudioDevice, GroqKeyStatus, Health } from "../../shared/api/types";
import type { SliceCreator } from "../types";

export interface SystemSlice {
	health: Health | null;
	devices: AudioDevice[];
	analysisModels: string[];
	groqKey: GroqKeyStatus;
	/** The stored Groq key passed a validation in this run (reset when the key changes). */
	groqValidated: boolean;
	loadHealth: () => Promise<void>;
	loadDevices: () => Promise<void>;
	/** Quiet, throttled re-enumeration (picker focus → hot-plugged devices show up). */
	refreshDevices: () => void;
	/** When `refreshDevices` last hit the server (epoch ms). */
	devicesRefreshedAt: number;
	loadAnalysisModels: () => Promise<void>;
	loadGroqKey: () => Promise<void>;
	saveGroqKey: (key: string) => Promise<boolean>;
	removeGroqKey: () => Promise<void>;
	/** Validates `key` (then saves it if valid) or, without a key, the stored one. */
	validateGroqKey: (key?: string) => Promise<boolean>;
	playTestSound: (device: string) => Promise<void>;
}

export const DEVICE_REFRESH_MS = 3000;

export const createSystemSlice: SliceCreator<SystemSlice> = (set, get) => ({
	health: null,
	devices: [],
	analysisModels: [],
	groqKey: { configured: false, masked: null },
	groqValidated: false,
	devicesRefreshedAt: 0,
	loadHealth: async () => {
		try {
			set({ health: await api.health() });
		} catch {
			set({ health: null });
		}
	},
	loadDevices: async () => {
		try {
			const { devices } = await api.devices();
			set({ devices });
		} catch (err) {
			get().pop(`Não foi possível listar os dispositivos: ${errorMessage(err)}`, "err");
		}
	},
	refreshDevices: () => {
		const now = Date.now();
		if (now - get().devicesRefreshedAt < DEVICE_REFRESH_MS) return;
		set({ devicesRefreshedAt: now });
		api
			.devices()
			.then(({ devices }) => set({ devices }))
			.catch(() => {
				// keep the current list; the explicit loads report errors
			});
	},
	loadAnalysisModels: async () => {
		try {
			const { models } = await api.analysisModels();
			set({ analysisModels: models });
		} catch {
			set({ analysisModels: [] });
		}
	},
	loadGroqKey: async () => {
		try {
			set({ groqKey: await api.getGroqKey() });
		} catch {
			// keep previous
		}
	},
	saveGroqKey: async (key) => {
		try {
			const { masked } = await api.setGroqKey(key.trim());
			set({ groqKey: { configured: true, masked }, groqValidated: false });
			void get().loadHealth();
			return true;
		} catch (err) {
			get().pop(`Não foi possível salvar a chave: ${errorMessage(err)}`, "err");
			return false;
		}
	},
	removeGroqKey: async () => {
		try {
			await api.deleteGroqKey();
			set({ groqKey: { configured: false, masked: null }, groqValidated: false });
			get().pop("Chave removida");
			void get().loadHealth();
		} catch (err) {
			get().pop(`Não foi possível remover a chave: ${errorMessage(err)}`, "err");
		}
	},
	validateGroqKey: async (key) => {
		try {
			const res = await api.validateGroqKey(key?.trim() || undefined);
			if (!res.valid) {
				if (!key?.trim()) set({ groqValidated: false });
				get().pop(`Chave inválida${res.error ? `: ${res.error}` : ""}`, "err");
				return false;
			}
			if (key?.trim() && !(await get().saveGroqKey(key))) return false;
			set({ groqValidated: true });
			get().pop("Chave válida — Groq conectado");
			return true;
		} catch (err) {
			get().pop(`Não foi possível validar: ${errorMessage(err)}`, "err");
			return false;
		}
	},
	playTestSound: async (device) => {
		try {
			await api.testAudio(device);
			get().pop("Tocando som de teste na saída selecionada…", "ac");
		} catch (err) {
			get().pop(`Não foi possível tocar o som: ${errorMessage(err)}`, "err");
		}
	},
});
