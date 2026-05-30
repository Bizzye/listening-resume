import { useRef, useEffect, useCallback, useState } from "react";
import { useStore } from "../../store";
import { Badge, Button, Input, ConfirmModal } from "../../shared/ui";
import { formatDuration, formatTimestamp } from "../../shared/lib/format";
import { BASE } from "../../shared/lib/api";
import {
  ArrowLeft,
  Play,
  Pause,
  Download,
  FileText,
  Brain,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { clsx } from "clsx";

export function SessionDetailPage() {
  const {
    sessions,
    selectedSessionId,
    setView,
    transcript,
    transcriptMeta,
    searchQuery,
    setSearchQuery,
    analyses,
    activeAnalysisTab,
    setActiveAnalysisTab,
    playbackTime,
    isPlaying,
    setPlaybackTime,
    togglePlayback,
    transcribeSession,
    analyzeSession,
    deleteAnalysis,
    deleteSession,
    loading,
    templates,
  } = useStore();

  const session = sessions.find((s) => s.id === selectedSessionId);
  if (!session) return null;

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Filter out Whisper silence artifacts
  const silenceArtifacts = [
    "thank you.",
    "thanks for watching.",
    "bye.",
    "you",
    "thanks.",
    "thank you for watching.",
    "off",
    "off.",
  ];
  const meaningfulTranscript = transcript?.filter(
    (seg) => !silenceArtifacts.includes(seg.text.trim().toLowerCase()),
  );

  const filteredTranscript = meaningfulTranscript?.filter(
    (seg) =>
      !searchQuery ||
      seg.text.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const tabs = ["Transcript", "Analysis", "Export"];
  const [activeTab, setActiveTab] = [activeAnalysisTab, setActiveAnalysisTab];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center gap-3">
        <button
          onClick={() => setView("sessions")}
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-hover text-text-secondary hover:text-text-primary transition-all cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-text-primary truncate">
              {session.title ?? `Session ${session.id.slice(0, 8)}`}
            </h1>
            <Badge status={session.status} />
          </div>
          <p className="text-xs text-text-muted">
            {formatDuration(session.duration)} · {session.chunks} chunks ·{" "}
            {session.audioSource ?? "Unknown device"}
          </p>
        </div>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-recording/10 text-text-muted hover:text-recording transition-all cursor-pointer"
          title="Apagar sessão"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <ConfirmModal
        open={showDeleteConfirm}
        title="Apagar sessão"
        message="Essa ação é irreversível. Todos os áudios, transcrições e análises desta sessão serão removidos permanentemente."
        confirmLabel="Apagar"
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          deleteSession(session.id);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {/* Tabs */}
      <div className="flex border-b border-border px-4">
        {tabs.map((tab, i) => {
          const disabled =
            i > 0 &&
            (!meaningfulTranscript || meaningfulTranscript.length === 0);
          return (
            <button
              key={tab}
              onClick={() => !disabled && setActiveTab(i)}
              disabled={disabled}
              className={clsx(
                "px-4 py-2.5 text-sm font-medium border-b-2 transition-all",
                disabled
                  ? "border-transparent text-text-muted/40 cursor-not-allowed"
                  : "cursor-pointer",
                !disabled && activeTab === i
                  ? "border-accent text-accent"
                  : !disabled &&
                      "border-transparent text-text-muted hover:text-text-secondary",
              )}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 0 &&
          (!transcript || transcript.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <FileText className="w-8 h-8 text-text-muted" />
              <p className="text-sm text-text-muted">No transcript yet</p>
              <Button
                size="sm"
                onClick={() => transcribeSession(session.id)}
                disabled={loading}
              >
                <FileText className="w-3.5 h-3.5" />{" "}
                {loading ? "Transcribing..." : "Transcribe"}
              </Button>
            </div>
          ) : !meaningfulTranscript || meaningfulTranscript.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <FileText className="w-8 h-8 text-text-muted" />
              <p className="text-sm text-text-muted">
                Nenhuma fala detectada nesta gravação
              </p>
              <p className="text-xs text-text-muted">
                O áudio não contém conteúdo de voz identificável.
              </p>
            </div>
          ) : (
            <TranscriptPanel
              segments={filteredTranscript ?? []}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sessionId={session.id}
              duration={session.duration}
              transcriptMeta={transcriptMeta}
            />
          ))}
        {activeTab === 1 && (
          <AnalysisPanel
            analyses={analyses}
            onAnalyze={(templateId) => analyzeSession(session.id, templateId)}
            onDelete={(analysisId) => deleteAnalysis(analysisId, session.id)}
            loading={loading}
            templates={templates}
          />
        )}
        {activeTab === 2 && <ExportPanel session={session} />}
      </div>
    </div>
  );
}

function TranscriptPanel({
  segments,
  searchQuery,
  onSearchChange,
  sessionId,
  duration,
  transcriptMeta,
}: {
  segments: { start: number; end: number; text: string }[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sessionId: string;
  duration: number;
  transcriptMeta: { provider: string | null; model: string | null } | null;
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioDuration] = useState(duration || 0);
  const [audioLoading, setAudioLoading] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start playback via server (uses system audio player, bypasses WebKit)
  const startPlayback = useCallback(
    async (seek = 0) => {
      setAudioLoading(true);
      try {
        const res = await fetch(`${BASE}/sessions/${sessionId}/play`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seek }),
        });
        if (!res.ok) throw new Error("Failed to start playback");
        setIsPlaying(true);
        setCurrentTime(seek);

        // Poll for time updates
        if (pollingRef.current) clearInterval(pollingRef.current);
        const startTs = Date.now();
        pollingRef.current = setInterval(() => {
          const elapsed = (Date.now() - startTs) / 1000;
          const t = seek + elapsed;
          if (t >= audioDuration && audioDuration > 0) {
            setIsPlaying(false);
            setCurrentTime(audioDuration);
            if (pollingRef.current) clearInterval(pollingRef.current);
          } else {
            setCurrentTime(t);
          }
        }, 250);
      } finally {
        setAudioLoading(false);
      }
    },
    [sessionId, audioDuration],
  );

  const stopPlayback = useCallback(async () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setIsPlaying(false);
    await fetch(`${BASE}/sessions/${sessionId}/play`, {
      method: "DELETE",
    }).catch(() => {});
  }, [sessionId]);

  const togglePlayback = useCallback(async () => {
    if (isPlaying) {
      await stopPlayback();
    } else {
      await startPlayback(currentTime < audioDuration ? currentTime : 0);
    }
  }, [isPlaying, stopPlayback, startPlayback, currentTime, audioDuration]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      fetch(`${BASE}/sessions/${sessionId}/play`, { method: "DELETE" }).catch(
        () => {},
      );
    };
  }, [sessionId]);

  const seekTo = useCallback(
    async (time: number) => {
      setCurrentTime(time);
      if (isPlaying) {
        await stopPlayback();
        await startPlayback(time);
      }
    },
    [isPlaying, stopPlayback, startPlayback],
  );

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const time = pct * audioDuration;
      seekTo(time);
    },
    [audioDuration, seekTo],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Player bar */}
      <div className="flex items-center gap-3 p-3 border-b border-border bg-surface-elevated">
        <button
          onClick={togglePlayback}
          disabled={audioLoading}
          className="w-8 h-8 rounded-full bg-accent flex items-center justify-center hover:bg-accent-hover transition-all cursor-pointer disabled:opacity-50"
        >
          {audioLoading ? (
            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : isPlaying ? (
            <Pause className="w-3.5 h-3.5 text-white" />
          ) : (
            <Play className="w-3.5 h-3.5 text-white ml-0.5" />
          )}
        </button>
        <span className="text-xs font-mono text-text-secondary">
          {formatTimestamp(currentTime)}
        </span>
        <div
          className="flex-1 h-1 rounded-full bg-surface-active overflow-hidden cursor-pointer"
          onClick={handleProgressClick}
        >
          <div
            className="h-full bg-accent rounded-full transition-all"
            style={{
              width: `${audioDuration > 0 ? (currentTime / audioDuration) * 100 : 0}%`,
            }}
          />
        </div>
        <span className="text-xs font-mono text-text-muted">
          {formatTimestamp(audioDuration)}
        </span>
        {transcriptMeta?.provider && (
          <span className="text-[10px] text-text-muted border-l border-border pl-3">
            {transcriptMeta.provider}/{transcriptMeta.model}
          </span>
        )}
      </div>

      {/* Search */}
      <div className="p-3 border-b border-border">
        <Input
          icon
          placeholder="Search transcript..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {/* Segments */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {segments.map((seg, i) => (
          <button
            key={i}
            onClick={() => seekTo(seg.start)}
            className={clsx(
              "w-full text-left px-3 py-2 rounded-lg flex gap-3 transition-all hover:bg-surface-hover cursor-pointer",
              currentTime >= seg.start &&
                currentTime < seg.end &&
                "bg-accent-subtle",
            )}
          >
            <span className="text-[10px] font-mono text-text-muted pt-1 shrink-0 w-10">
              {formatTimestamp(seg.start)}
            </span>
            <span className="text-sm text-text-primary leading-relaxed">
              {seg.text}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AnalysisPanel({
  analyses,
  onAnalyze,
  onDelete,
  loading,
  templates,
}: {
  analyses: {
    id: string;
    templateId: string;
    provider: string;
    model: string;
    content: string;
    createdAt: string;
  }[];
  onAnalyze: (templateId?: string) => void;
  onDelete: (analysisId: string) => void;
  loading: boolean;
  templates: { id: string; name: string; builtin: boolean }[];
}) {
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    templates[0]?.id ?? "",
  );

  if (analyses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Brain className="w-8 h-8 text-text-muted" />
        <p className="text-sm text-text-muted">No analysis generated yet</p>
        {templates.length > 0 && (
          <select
            className="bg-bg-secondary border border-border rounded px-2 py-1 text-sm text-text-primary"
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          onClick={() => onAnalyze(selectedTemplateId || undefined)}
          disabled={loading}
        >
          <Brain className="w-3.5 h-3.5" />{" "}
          {loading ? "Analyzing..." : "Generate Analysis"}
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {analyses.map((analysis) => (
        <div key={analysis.id}>
          <div className="flex items-center gap-2 mb-3">
            <Brain className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-medium text-text-primary">
              {templates.find((t) => t.id === analysis.templateId)?.name ??
                analysis.templateId}
            </h3>
            <span className="text-xs text-text-muted ml-auto">
              {analysis.provider}/{analysis.model}
            </span>
            <button
              onClick={() => onDelete(analysis.id)}
              className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-recording cursor-pointer"
              title="Excluir análise"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="prose prose-invert prose-sm max-w-none text-text-secondary [&_h2]:text-text-primary [&_h2]:text-base [&_h2]:mt-4 [&_h2]:mb-2 [&_li]:text-text-secondary [&_strong]:text-text-primary">
            <ReactMarkdown>{analysis.content}</ReactMarkdown>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        {templates.length > 0 && (
          <select
            className="bg-bg-secondary border border-border rounded px-2 py-1 text-sm text-text-primary"
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onAnalyze(selectedTemplateId || undefined)}
          disabled={loading}
        >
          <Brain className="w-3.5 h-3.5" /> Run Again
        </Button>
      </div>
    </div>
  );
}

function ExportPanel({
  session,
}: {
  session: { id: string; title: string | null };
}) {
  const { config } = useStore();
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [savedPath, setSavedPath] = useState("");

  const handleExportMarkdown = () => {
    window.open(`${BASE}/sessions/${session.id}/export`, "_blank");
  };

  const handleExportText = async () => {
    const res = await fetch(`${BASE}/sessions/${session.id}`);
    const data = await res.json();
    if (!data.transcript) return;
    const text = data.transcript.segments
      .map((s: { text: string }) => s.text)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${session.id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveToDisk = async (format: "markdown" | "text") => {
    setSaveStatus("saving");
    try {
      const res = await fetch(`${BASE}/sessions/${session.id}/export/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSavedPath(data.path);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 5000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <h3 className="text-sm font-medium text-text-primary">Export Options</h3>

      {/* Download */}
      <div className="grid grid-cols-2 gap-3">
        <ExportCard
          icon={FileText}
          title="Markdown"
          description="Full session with transcript + analysis"
          onClick={handleExportMarkdown}
        />
        <ExportCard
          icon={Download}
          title="Plain Text"
          description="Transcript only as .txt"
          onClick={handleExportText}
        />
      </div>

      {/* Save to folder */}
      <div className="border-t border-border pt-4">
        <h3 className="text-sm font-medium text-text-primary mb-1">
          Save to Folder
        </h3>
        <p className="text-xs text-text-muted mb-3">
          {config.exportDir || "~/Documents/listening-resume"}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => handleSaveToDisk("markdown")}
            disabled={saveStatus === "saving"}
          >
            <FileText className="w-3.5 h-3.5" /> Save .md
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleSaveToDisk("text")}
            disabled={saveStatus === "saving"}
          >
            <Download className="w-3.5 h-3.5" /> Save .txt
          </Button>
        </div>
        {saveStatus === "saved" && (
          <p className="text-xs text-success mt-2">Saved: {savedPath}</p>
        )}
        {saveStatus === "error" && (
          <p className="text-xs text-recording mt-2">Error saving file</p>
        )}
      </div>
    </div>
  );
}

function ExportCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof FileText;
  title: string;
  description: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="p-4 rounded-xl border border-border bg-surface-elevated hover:bg-surface-hover text-left transition-all cursor-pointer"
    >
      <Icon className="w-5 h-5 text-accent mb-2" />
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="text-xs text-text-muted mt-1">{description}</p>
    </button>
  );
}
