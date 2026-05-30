import { useStore } from "../../store";
import { Card, Badge } from "../../shared/ui";
import { Mic, Clock, FileText, Zap } from "lucide-react";
import { formatDuration, formatRelativeDate } from "../../shared/lib/format";

export function DashboardPage() {
  const { sessions, selectSession, isRecording, startRecording } = useStore();
  const totalDuration = sessions.reduce((acc, s) => acc + s.duration, 0);
  const totalSessions = sessions.length;
  const transcribedSessions = sessions.filter((s) =>
    ["transcribed", "analyzing", "completed"].includes(s.status),
  ).length;
  const analyzedSessions = sessions.filter(
    (s) => s.status === "completed",
  ).length;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Dashboard</h1>
          <p className="text-sm text-text-secondary mt-0.5">
            Overview of your listening sessions
          </p>
        </div>
        <button
          onClick={startRecording}
          disabled={isRecording}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
        >
          <Mic className="w-4 h-4" />
          New Recording
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          icon={Mic}
          label="Total Sessions"
          value={totalSessions.toString()}
        />
        <StatCard
          icon={Clock}
          label="Total Recorded"
          value={formatDuration(totalDuration)}
        />
        <StatCard
          icon={FileText}
          label="Transcribed"
          value={transcribedSessions.toString()}
        />
        <StatCard
          icon={Zap}
          label="Analyzed"
          value={analyzedSessions.toString()}
        />
      </div>

      {/* Recent sessions */}
      <div>
        <h2 className="text-sm font-medium text-text-secondary mb-3">
          Recent Sessions
        </h2>
        <div className="space-y-2">
          {sessions.map((session) => (
            <Card key={session.id} onClick={() => selectSession(session.id)}>
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-text-primary truncate">
                      {session.title ?? `Session ${session.id.slice(0, 8)}`}
                    </h3>
                    <Badge status={session.status} />
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    {formatRelativeDate(session.startedAt ?? session.createdAt)}{" "}
                    · {formatDuration(session.duration)} ·{" "}
                    {session.audioSource ?? "Unknown"}
                  </p>
                  {session.preview && (
                    <p className="text-xs text-text-secondary mt-1 truncate">
                      {session.preview}
                    </p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Mic;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-lg bg-accent-subtle flex items-center justify-center">
          <Icon className="w-3.5 h-3.5 text-accent" />
        </div>
      </div>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </div>
  );
}
