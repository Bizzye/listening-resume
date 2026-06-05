import { useState, useEffect } from "react";
import { useStore } from "../../store";
import {
  Headphones,
  Brain,
  Mic,
  Zap,
  Server,
  Volume2,
  Key,
  FolderOutput,
} from "lucide-react";
import { api, BASE } from "../../shared/lib/api";

export function SettingsPage() {
  const {
    config,
    devices,
    selectedDevice,
    setSelectedDevice,
    selectedMicDevice,
    setSelectedMicDevice,
    templates,
    fetchConfig,
    fetchDevices,
    setView,
  } = useStore();

  // Re-fetch devices when opening Settings — recovers if the initial app-load
  // fetch failed (e.g. raced a dev server restart) and left the list empty.
  useEffect(() => {
    if (devices.length === 0) fetchDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"idle" | "success" | "error">(
    "idle",
  );
  const [groqKey, setGroqKey] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState<
    "idle" | "saved" | "error" | "invalid"
  >("idle");
  const [exportDir, setExportDir] = useState(config.exportDir || "");
  const [exportDirStatus, setExportDirStatus] = useState<
    "idle" | "saved" | "error"
  >("idle");

  const testAudio = async () => {
    const device = selectedDevice || devices[0]?.id;
    if (!device) return;

    setTesting(true);
    setTestResult("idle");

    try {
      const res = await fetch(`${BASE}/audio/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device }),
      });

      if (!res.ok) {
        setTestResult("error");
      } else {
        setTestResult("success");
        setTimeout(() => setTestResult("idle"), 4000);
      }
    } catch {
      setTestResult("error");
    }
    setTesting(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h1 className="text-xl font-semibold text-text-primary">Settings</h1>

      {/* Audio */}
      <SettingsSection title="Audio" icon={Headphones}>
        <div className="px-4 py-3">
          <label className="text-sm text-text-secondary block mb-2">
            Recording Device
          </label>
          <select
            value={selectedDevice ?? ""}
            onChange={(e) => setSelectedDevice(e.target.value)}
            aria-label="Recording device"
            data-testid="recording-device-select"
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 cursor-pointer [color-scheme:dark]"
          >
            {devices
              .filter((d) => d.type !== "microphone")
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.isDefault ? "(default)" : ""}
                </option>
              ))}
            {devices.length === 0 && (
              <option value="">Loading devices...</option>
            )}
          </select>
          {config.device && (
            <p className="text-xs text-text-muted mt-1">
              Config default: {config.device}
            </p>
          )}
          <button
            onClick={testAudio}
            disabled={testing}
            data-testid="test-sound-button"
            className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Volume2 className="w-4 h-4" />
            {testing ? "Playing..." : "Test Sound"}
          </button>
          {testResult === "success" && (
            <p data-testid="test-sound-result" className="text-xs text-success mt-1">
              Sound played — if you heard it, this device is correct.
            </p>
          )}
          {testResult === "error" && (
            <p data-testid="test-sound-result" className="text-xs text-recording mt-1">
              Failed to play test sound.
            </p>
          )}

          <label className="text-sm text-text-secondary block mb-2 mt-4">
            Microphone (optional)
          </label>
          <select
            value={selectedMicDevice ?? ""}
            onChange={(e) => setSelectedMicDevice(e.target.value || null)}
            aria-label="Microphone device"
            data-testid="mic-device-select"
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 cursor-pointer [color-scheme:dark]"
          >
            <option value="">Nenhum (somente áudio do sistema)</option>
            {devices
              .filter((d) => d.type === "microphone")
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.isDefault ? "(default)" : ""}
                </option>
              ))}
          </select>
          <p className="text-xs text-text-muted mt-1">
            Se selecionado, seu microfone será mixado com o áudio do sistema na gravação.
          </p>
        </div>
      </SettingsSection>

      {/* Transcription */}
      <SettingsSection title="Transcription" icon={Mic}>
        <SettingRow
          label="Provider"
          value={config.transcriptionProvider || "—"}
        />
        <SettingRow label="Model" value={config.transcriptionModel || "—"} />
        <SettingRow
          label="Groq API Key"
          value={config.hasGroqKey ? "✓ Configurada" : "✗ Não configurada"}
        />
      </SettingsSection>

      {/* Groq API Key */}
      <SettingsSection title="Groq API Key" icon={Key}>
        <div className="px-4 py-3">
          {config.hasGroqKey ? (
            <>
              <div className="flex items-center gap-2">
                <span className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary font-mono select-all">
                  {config.maskedGroqKey}
                </span>
                <button
                  onClick={async () => {
                    setKeySaving(true);
                    try {
                      await api.deleteGroqKey();
                      await fetchConfig();
                      setKeyStatus("idle");
                    } catch {
                      setKeyStatus("error");
                    }
                    setKeySaving(false);
                  }}
                  disabled={keySaving}
                  className="px-4 py-2 rounded-lg bg-recording/10 border border-recording/30 text-recording text-sm font-medium hover:bg-recording/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {keySaving ? "Apagando..." : "Apagar"}
                </button>
              </div>
              {keyStatus === "error" && (
                <p className="text-xs text-recording mt-1">
                  Erro ao apagar a chave.
                </p>
              )}
            </>
          ) : (
            <>
              <label className="text-sm text-text-secondary block mb-2">
                Insira sua chave da API Groq:
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={groqKey}
                  onChange={(e) => setGroqKey(e.target.value)}
                  placeholder="gsk_..."
                  className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 font-mono"
                />
                <button
                  onClick={async () => {
                    if (!groqKey.trim()) return;
                    setKeySaving(true);
                    setKeyStatus("idle");
                    try {
                      const trimmed = groqKey.trim();
                      if (!trimmed.match(/^gsk_[a-zA-Z0-9]{20,}$/)) {
                        setKeyStatus("invalid");
                        setKeySaving(false);
                        return;
                      }
                      await api.setGroqKey(trimmed);
                      setKeyStatus("saved");
                      setGroqKey("");
                      await fetchConfig();
                      setTimeout(() => setKeyStatus("idle"), 3000);
                    } catch {
                      setKeyStatus("error");
                    }
                    setKeySaving(false);
                  }}
                  disabled={keySaving || !groqKey.trim()}
                  className="px-4 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {keySaving ? "Salvando..." : "Salvar"}
                </button>
              </div>
              {keyStatus === "saved" && (
                <p className="text-xs text-success mt-1">
                  Chave salva com sucesso!
                </p>
              )}
              {keyStatus === "invalid" && (
                <p className="text-xs text-recording mt-1">
                  Formato inválido. A chave deve começar com gsk_
                </p>
              )}
              {keyStatus === "error" && (
                <p className="text-xs text-recording mt-1">
                  Erro ao salvar a chave.
                </p>
              )}
            </>
          )}
          <p className="text-xs text-text-muted mt-2">
            Obtenha sua chave em{" "}
            <a
              href="https://console.groq.com/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              console.groq.com/keys
            </a>
            . Usada para transcrição (Whisper) e como fallback de análise.
          </p>
        </div>
      </SettingsSection>

      {/* Analysis */}
      <SettingsSection title="Analysis" icon={Brain}>
        <SettingRow label="Provider" value={config.analysisProvider || "—"} />
        <SettingRow label="Model" value={config.analysisModel || "—"} />
        <div className="px-4 py-3">
          <label className="text-sm text-text-secondary block mb-2">
            Templates de análise
          </label>
          <div className="space-y-1.5">
            {templates.slice(0, 3).map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 text-sm text-text-primary"
              >
                <span className="truncate">{t.name}</span>
                {t.builtin && (
                  <span className="text-xs bg-accent/10 text-accent px-1.5 py-0.5 rounded">
                    builtin
                  </span>
                )}
              </div>
            ))}
            {templates.length > 3 && (
              <p className="text-xs text-text-muted">
                +{templates.length - 3} mais...
              </p>
            )}
            {templates.length === 0 && (
              <p className="text-xs text-text-muted">
                Nenhum template configurado.
              </p>
            )}
          </div>
          <button
            onClick={() => setView("templates")}
            className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-all cursor-pointer"
          >
            Gerenciar Templates
          </button>
        </div>
      </SettingsSection>

      {/* Export */}
      <SettingsSection title="Export" icon={FolderOutput}>
        <div className="px-4 py-3">
          <label className="text-sm text-text-secondary block mb-2">
            Export Directory
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={exportDir}
              onChange={(e) => setExportDir(e.target.value)}
              placeholder="~/Documents/listening-resume"
              className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 font-mono"
            />
            <button
              onClick={async () => {
                if (!exportDir.trim()) return;
                try {
                  const res = await fetch(`${BASE}/config/export-dir`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ dir: exportDir.trim() }),
                  });
                  if (!res.ok) throw new Error();
                  setExportDirStatus("saved");
                  await fetchConfig();
                  setTimeout(() => setExportDirStatus("idle"), 3000);
                } catch {
                  setExportDirStatus("error");
                  setTimeout(() => setExportDirStatus("idle"), 3000);
                }
              }}
              disabled={!exportDir.trim()}
              className="px-4 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Salvar
            </button>
          </div>
          {exportDirStatus === "saved" && (
            <p className="text-xs text-success mt-1">Diretório salvo!</p>
          )}
          {exportDirStatus === "error" && (
            <p className="text-xs text-recording mt-1">
              Erro ao salvar diretório.
            </p>
          )}
          <p className="text-xs text-text-muted mt-2">
            Pasta onde os arquivos exportados serão salvos automaticamente.
          </p>
        </div>
      </SettingsSection>

      {/* Status */}
      <SettingsSection title="Services Status" icon={Server}>
        <ServiceStatus name="API Server" status="connected" />
        <ServiceStatus
          name="Groq API"
          status={config.hasGroqKey ? "connected" : "disconnected"}
        />
        <ServiceStatus name="FFmpeg" status="connected" />
        <ServiceStatus
          name={navigator.platform.startsWith("Win") ? "WASAPI" : "PipeWire"}
          status={devices.length > 0 ? "connected" : "disconnected"}
        />
      </SettingsSection>

      {/* Config file hint */}
      <div className="rounded-xl border border-border bg-surface-elevated p-4">
        <div className="flex items-center gap-2 mb-2">
          <Zap className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-medium text-text-primary">
            Configuration
          </h2>
        </div>
        <p className="text-xs text-text-muted leading-relaxed">
          Edit{" "}
          <code className="text-text-secondary">
            ~/.config/listening-resume/config.toml
          </code>{" "}
          to change default settings. Set{" "}
          <code className="text-text-secondary">GROQ_API_KEY</code> in{" "}
          <code className="text-text-secondary">.env</code> for transcription.
        </p>
      </div>
    </div>
  );
}

function SettingsSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Brain;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-elevated overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Icon className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-medium text-text-primary">{title}</h2>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className="text-sm text-text-primary font-mono">{value}</span>
    </div>
  );
}

function ServiceStatus({
  name,
  status,
}: {
  name: string;
  status: "connected" | "disconnected";
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-text-secondary">{name}</span>
      <div className="flex items-center gap-2">
        <div
          className={`w-2 h-2 rounded-full ${
            status === "connected" ? "bg-success" : "bg-recording"
          }`}
        />
        <span className="text-xs text-text-muted capitalize">{status}</span>
      </div>
    </div>
  );
}
