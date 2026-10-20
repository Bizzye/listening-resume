// Wire types for the local HTTP API (contract section 4). Shared domain/capture types come from
// the browser-safe `@listening-resume/core/shared` entry (never the Node-only main entry).

export type {
	Analysis,
	AudioDevice,
	AudioLevels,
	CaptureDevices,
	CaptureSource,
	ResolvedDevices,
	Session,
	SessionStatus,
	SessionSummary,
	Settings,
	TranscriptSegment,
} from "@listening-resume/core/shared";
export { SYSTEM_DEFAULT_DEVICE } from "../lib/core-shared";

import type {
	Analysis,
	CaptureSource,
	ResolvedDevices,
	Session,
	SessionSummary,
	Settings,
	TranscriptSegment,
} from "@listening-resume/core/shared";

/** The transcript as the API returns it (UI-only view of core's `Transcript`). */
export interface Transcript {
	segments: TranscriptSegment[];
	fullText: string;
	language: string | null;
	provider: string | null;
	model: string | null;
}

export interface SessionDetail {
	session: SessionSummary;
	transcript: Transcript | null;
	analyses: Analysis[];
}

export interface Template {
	id: string;
	name: string;
	description: string;
	prompt: string;
	builtin: boolean;
	sections: number;
	language: string;
}

export interface TemplateInput {
	name: string;
	description: string;
	prompt: string;
}

export type Theme = Settings["theme"];
export type ExportFormat = Settings["exportFormat"];

export interface Health {
	services: {
		ollama: { ok: boolean; model: string; url: string };
		groq: { configured: boolean };
		ffmpeg: { ok: boolean; version: string | null };
		whisper: { ok: boolean; model: string };
		capture: {
			backend: "wasapi" | "pulse" | "fake";
			ok: boolean;
			/** Capture capabilities (absent on older servers = assume supported). */
			levels?: boolean;
			liveSwitch?: boolean;
			meter?: boolean;
			/** Output WAV sample rate (Hz), when the server reports it. */
			sampleRate?: number;
		};
	};
}

export interface GroqKeyStatus {
	configured: boolean;
	masked: string | null;
}

export type RecordingStatus =
	| { recording: false }
	| {
			recording: true;
			sessionId: string;
			startTime: number;
			chunks: number;
			devices: ResolvedDevices | null;
			muted: Record<CaptureSource, boolean>;
	  };

export interface StartRecordingResult {
	session: Session;
	startTime: number;
	devices: ResolvedDevices | null;
}

export interface DeviceSwitch {
	device?: string;
	micDevice?: string | null;
}
