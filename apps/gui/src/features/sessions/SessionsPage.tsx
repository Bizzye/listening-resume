import { useStore } from "../../store";
import { Card, Badge } from "../../shared/ui";
import { Input } from "../../shared/ui";
import { formatDuration, formatRelativeDate } from "../../shared/lib/format";
import { useState } from "react";

export function SessionsPage() {
  const { sessions, selectSession } = useStore();
  const [filter, setFilter] = useState("");

  const filtered = sessions.filter(
    (s) =>
      !filter ||
      s.title?.toLowerCase().includes(filter.toLowerCase()) ||
      s.id.includes(filter),
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Sessions</h1>
        <span className="text-xs text-text-muted">{sessions.length} total</span>
      </div>

      <Input
        icon
        placeholder="Search sessions..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="space-y-2">
        {filtered.map((session) => (
          <Card
            key={session.id}
            onClick={() => selectSession(session.id)}
            data-testid="session-card"
            data-session-id={session.id}
          >
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-text-primary truncate">
                    {session.title ?? `Session ${session.id.slice(0, 8)}`}
                  </h3>
                  <Badge status={session.status} />
                </div>
                <p className="text-xs text-text-muted mt-1">
                  {formatRelativeDate(session.startedAt ?? session.createdAt)} ·{" "}
                  {formatDuration(session.duration)} · {session.chunks} chunks
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
        {filtered.length === 0 && (
          <p className="text-center text-text-muted text-sm py-8">
            No sessions found
          </p>
        )}
      </div>
    </div>
  );
}
