import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  api,
  type SessionData,
  type TranscriptSegment,
  type AnalysisData,
  type AudioDevice,
  type AnalysisTemplateData,
} from "../shared/lib/api";

export type View =
  | "dashboard"
  | "recording"
  | "session"
  | "sessions"
  | "settings"
  | "templates";

interface AppState {
  // Navigation
  view: View;
  selectedSessionId: string | null;
  setView: (view: View) => void;
  selectSession: (id: string) => void;

  // Recording
  isRecording: boolean;
  recordingStartTime: number | null;
  recordingChunks: number;
  recordingDevice: string;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;

  // Devices
  devices: AudioDevice[];
  selectedDevice: string | null;
  selectedMicDevice: string | null;
  fetchDevices: () => Promise<void>;
  setSelectedDevice: (device: string) => void;
  setSelectedMicDevice: (device: string | null) => void;

  // Sessions
  sessions: SessionData[];
  fetchSessions: () => Promise<void>;

  // Session detail
  transcript: TranscriptSegment[] | null;
  transcriptMeta: { provider: string | null; model: string | null } | null;
  analyses: AnalysisData[];
  fetchSessionDetail: (id: string) => Promise<void>;
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // Analysis
  activeAnalysisTab: number;
  setActiveAnalysisTab: (i: number) => void;

  // Transcribe/Analyze actions
  transcribeSession: (id: string) => Promise<void>;
  analyzeSession: (id: string, templateId?: string) => Promise<void>;
  deleteAnalysis: (analysisId: string, sessionId: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  // Templates
  templates: AnalysisTemplateData[];
  fetchTemplates: () => Promise<void>;
  createTemplate: (name: string, userPromptTemplate: string) => Promise<void>;
  updateTemplate: (
    id: string,
    data: { name?: string; userPromptTemplate?: string },
  ) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;

  // Settings (from server config)
  config: {
    device: string;
    micDevice: string | null;
    micVolume: number;
    transcriptionProvider: string;
    transcriptionModel: string;
    analysisProvider: string;
    analysisModel: string;
    exportDir: string;
    hasGroqKey: boolean;
    maskedGroqKey: string | null;
  };
  fetchConfig: () => Promise<void>;

  // Playback
  playbackTime: number;
  isPlaying: boolean;
  setPlaybackTime: (t: number) => void;
  togglePlayback: () => void;

  // Loading/error
  loading: boolean;
  error: string | null;
  clearError: () => void;

  // Init
  init: () => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  // Navigation
  view: "dashboard",
  selectedSessionId: null,
  setView: (view) => set({ view }),
  selectSession: async (id) => {
    set({
      selectedSessionId: id,
      view: "session",
      transcript: null,
      transcriptMeta: null,
      analyses: [],
    });
    await get().fetchSessionDetail(id);
  },

  // Recording
  isRecording: false,
  recordingStartTime: null,
  recordingChunks: 0,
  recordingDevice: "",
  startRecording: async () => {
    try {
      const device = get().selectedDevice ?? get().config.device;
      const micDevice = get().selectedMicDevice;
      const result = await api.startRecording(device, micDevice);
      set({
        isRecording: true,
        recordingStartTime: result.startTime,
        recordingChunks: 0,
        recordingDevice: device,
        view: "recording",
        error: null,
      });
      invoke("set_tray_recording", { recording: true }).catch((e) =>
        console.warn("tray invoke failed:", e),
      );
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "Failed to start recording",
      });
    }
  },
  stopRecording: async () => {
    try {
      await api.stopRecording();
      set({
        isRecording: false,
        recordingStartTime: null,
        view: "dashboard",
      });
      invoke("set_tray_recording", { recording: false }).catch((e) =>
        console.warn("tray invoke failed:", e),
      );
      await get().fetchSessions();
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "Failed to stop recording",
      });
    }
  },

  // Devices
  devices: [],
  selectedDevice: localStorage.getItem("listening-resume:device") || null,
  selectedMicDevice:
    localStorage.getItem("listening-resume:mic-device") || null,
  fetchDevices: async () => {
    // Retry a few times: in dev the API server restarts on every file change, so
    // the initial fetch can race a reload and otherwise leave the dropdown stuck
    // on "Loading devices..." forever (no auto-retry).
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const devices = await api.getDevices();
        if (devices.length > 0) {
          set({ devices, error: null });
          if (!get().selectedDevice) {
            const def =
              devices.find((d) => d.isDefault && d.type === "monitor") ??
              devices.find((d) => d.type === "monitor");
            if (def) set({ selectedDevice: def.id });
          }
          return;
        }
      } catch (err: unknown) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    set({
      error:
        lastErr instanceof Error ? lastErr.message : "Failed to fetch devices",
    });
  },
  setSelectedDevice: (device) => {
    localStorage.setItem("listening-resume:device", device);
    set({ selectedDevice: device });
  },
  setSelectedMicDevice: (device) => {
    if (device) {
      localStorage.setItem("listening-resume:mic-device", device);
    } else {
      localStorage.removeItem("listening-resume:mic-device");
    }
    set({ selectedMicDevice: device });
    api.setMicConfig(device).catch(() => {});
  },

  // Sessions
  sessions: [],
  fetchSessions: async () => {
    try {
      const sessions = await api.getSessions();
      set({ sessions });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch sessions",
      });
    }
  },

  // Session detail
  transcript: null,
  transcriptMeta: null,
  analyses: [],
  fetchSessionDetail: async (id) => {
    try {
      set({ loading: true });
      const data = await api.getSession(id);
      set({
        transcript: data.transcript?.segments ?? null,
        transcriptMeta: data.transcript
          ? { provider: data.transcript.provider, model: data.transcript.model }
          : null,
        analyses: data.analyses,
        loading: false,
      });
    } catch (err: unknown) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to fetch session",
      });
    }
  },
  searchQuery: "",
  setSearchQuery: (q) => set({ searchQuery: q }),

  // Analysis tabs
  activeAnalysisTab: 0,
  setActiveAnalysisTab: (i) => set({ activeAnalysisTab: i }),

  // Transcribe/Analyze
  transcribeSession: async (id) => {
    try {
      set({ loading: true });
      await api.transcribe(id);
      await get().fetchSessionDetail(id);
      await get().fetchSessions();
    } catch (err: unknown) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Transcription failed",
      });
    }
  },
  analyzeSession: async (id, templateId) => {
    try {
      set({ loading: true });
      await api.analyze(id, templateId);
      await get().fetchSessionDetail(id);
      await get().fetchSessions();
    } catch (err: unknown) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Analysis failed",
      });
    }
  },

  deleteAnalysis: async (analysisId, sessionId) => {
    try {
      await api.deleteAnalysis(analysisId);
      await get().fetchSessionDetail(sessionId);
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "Failed to delete analysis",
      });
    }
  },

  deleteSession: async (id) => {
    try {
      await api.deleteSession(id);
      set({ view: "sessions", selectedSessionId: null });
      await get().fetchSessions();
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "Failed to delete session",
      });
    }
  },

  // Templates
  templates: [],
  fetchTemplates: async () => {
    try {
      const { templates } = await api.getTemplates();
      set({ templates });
    } catch {
      // Non-critical
    }
  },
  createTemplate: async (name, userPromptTemplate) => {
    await api.createTemplate({ name, userPromptTemplate });
    await get().fetchTemplates();
  },
  updateTemplate: async (id, data) => {
    await api.updateTemplate(id, data);
    await get().fetchTemplates();
  },
  deleteTemplate: async (id) => {
    await api.deleteTemplate(id);
    await get().fetchTemplates();
  },

  // Config
  config: {
    device: "",
    micDevice: null,
    micVolume: 1.2,
    transcriptionProvider: "",
    transcriptionModel: "",
    analysisProvider: "",
    analysisModel: "",
    exportDir: "",
    hasGroqKey: false,
    maskedGroqKey: null,
  },
  fetchConfig: async () => {
    try {
      const cfg = await api.getConfig();
      set({
        config: {
          device: cfg.audio.device,
          micDevice: cfg.audio.micDevice,
          micVolume: cfg.audio.micVolume,
          transcriptionProvider: cfg.transcription.provider,
          transcriptionModel: cfg.transcription.model,
          analysisProvider: cfg.analysis.provider,
          analysisModel: cfg.analysis.model,
          exportDir: cfg.exportDir,
          hasGroqKey: cfg.hasGroqKey,
          maskedGroqKey: cfg.maskedGroqKey,
        },
      });
      // Sync micDevice from server config if not set locally
      if (cfg.audio.micDevice && !get().selectedMicDevice) {
        set({ selectedMicDevice: cfg.audio.micDevice });
        localStorage.setItem(
          "listening-resume:mic-device",
          cfg.audio.micDevice,
        );
      }
    } catch {
      // Config fetch is non-critical
    }
  },

  // Playback
  playbackTime: 0,
  isPlaying: false,
  setPlaybackTime: (t) => set({ playbackTime: t }),
  togglePlayback: () => set((s) => ({ isPlaying: !s.isPlaying })),

  // Loading/error
  loading: false,
  error: null,
  clearError: () => set({ error: null }),

  // Init — called on app start
  init: async () => {
    // Wait for the server to be ready (it starts as a child process)
    for (let i = 0; i < 10; i++) {
      try {
        await api.getRecordingStatus();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    try {
      const status = await api.getRecordingStatus();
      if (status.recording) {
        set({
          isRecording: true,
          recordingStartTime: status.startTime ?? Date.now(),
          recordingChunks: status.chunks ?? 0,
          view: "recording",
        });
      }
    } catch {
      // Server not available yet
    }

    // Device enumeration self-retries (up to ~6s) to survive a server still booting,
    // so fire it without blocking the rest of init — otherwise the whole app waits on it.
    get().fetchDevices();
    await Promise.all([
      get().fetchSessions(),
      get().fetchConfig(),
      get().fetchTemplates(),
    ]);
  },
}));
