export const BASE =
  window.location.hostname === "localhost" && window.location.port === "1420"
    ? "/api"
    : "http://localhost:3456/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export interface AudioDevice {
  id: string;
  name: string;
  isMonitor: boolean;
  isDefault: boolean;
  type: "monitor" | "microphone";
}

export interface SessionData {
  id: string;
  title: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  audioSource: string | null;
  language: string;
  createdAt: string;
  chunks: number;
  duration: number;
  preview: string | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface AnalysisData {
  id: string;
  sessionId: string;
  templateId: string;
  provider: string;
  model: string;
  content: string;
  createdAt: string;
}

export interface AnalysisTemplateData {
  id: string;
  name: string;
  userPromptTemplate: string;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  // Devices
  async getDevices(): Promise<AudioDevice[]> {
    const data = await request<{ devices: AudioDevice[] }>("/devices");
    return data.devices;
  },

  // Sessions
  async getSessions(limit = 50): Promise<SessionData[]> {
    const data = await request<{ sessions: SessionData[] }>(
      `/sessions?limit=${limit}`,
    );
    return data.sessions;
  },

  async getSession(id: string): Promise<{
    session: SessionData;
    transcript: {
      segments: TranscriptSegment[];
      fullText: string;
      language: string | null;
      provider: string | null;
      model: string | null;
    } | null;
    analyses: AnalysisData[];
  }> {
    return request(`/sessions/${id}`);
  },

  // Recording
  async startRecording(
    device?: string,
    micDevice?: string | null,
  ): Promise<{ session: { id: string }; startTime: number }> {
    return request("/recording/start", {
      method: "POST",
      body: JSON.stringify({ device, micDevice }),
    });
  },

  async stopRecording(): Promise<{ session: unknown; chunks: number }> {
    return request("/recording/stop", { method: "POST" });
  },

  async getRecordingStatus(): Promise<{
    recording: boolean;
    sessionId?: string;
    startTime?: number;
    chunks?: number;
  }> {
    return request("/recording/status");
  },

  async setMute(target: "mic" | "system", muted: boolean): Promise<void> {
    await request("/recording/mute", {
      method: "POST",
      body: JSON.stringify({ target, muted }),
    });
  },

  async getRecordingLevels(): Promise<{
    system: { volume: number; muted: boolean };
    mic: { volume: number; muted: boolean };
  }> {
    return request("/recording/levels");
  },

  // Transcription & Analysis
  async transcribe(sessionId: string): Promise<{
    transcript: { segments: TranscriptSegment[]; fullText: string };
  }> {
    return request(`/sessions/${sessionId}/transcribe`, { method: "POST" });
  },

  async analyze(
    sessionId: string,
    templateId?: string,
  ): Promise<{ analysis: AnalysisData }> {
    return request(`/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: JSON.stringify({ templateId }),
    });
  },

  async deleteAnalysis(id: string): Promise<void> {
    await request(`/analyses/${id}`, { method: "DELETE" });
  },

  // Config
  async getConfig(): Promise<{
    audio: {
      device: string;
      micDevice: string | null;
      micVolume: number;
      sampleRate: number;
    };
    transcription: { provider: string; model: string };
    analysis: { provider: string; model: string };
    exportDir: string;
    hasGroqKey: boolean;
    maskedGroqKey: string | null;
  }> {
    return request("/config");
  },

  async setMicConfig(
    micDevice: string | null,
    micVolume?: number,
  ): Promise<void> {
    await request("/config/mic", {
      method: "POST",
      body: JSON.stringify({ micDevice, micVolume }),
    });
  },

  async getTemplates(): Promise<{
    templates: AnalysisTemplateData[];
  }> {
    return request("/templates");
  },

  async createTemplate(data: {
    name: string;
    userPromptTemplate: string;
  }): Promise<{
    template: AnalysisTemplateData;
  }> {
    return request("/templates", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async updateTemplate(
    id: string,
    data: { name?: string; userPromptTemplate?: string },
  ): Promise<{
    template: AnalysisTemplateData;
  }> {
    return request(`/templates/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  async deleteTemplate(id: string): Promise<void> {
    await request(`/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async setGroqKey(key: string): Promise<{ ok: boolean; hasGroqKey: boolean }> {
    return request("/config/groq-key", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  },

  async deleteGroqKey(): Promise<{ ok: boolean }> {
    return request("/config/groq-key", { method: "DELETE" });
  },

  async deleteSession(id: string): Promise<void> {
    await request(`/sessions/${id}`, { method: "DELETE" });
  },
};
