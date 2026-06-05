import { clsx } from "clsx";
import {
  Mic,
  LayoutDashboard,
  Clock,
  Settings,
  Headphones,
  FileText,
} from "lucide-react";
import { useStore, type View } from "../../store";

const navItems: { id: View; icon: typeof Mic; label: string }[] = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { id: "sessions", icon: Clock, label: "Sessions" },
  { id: "templates", icon: FileText, label: "Templates" },
  { id: "settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const { view, setView, isRecording, startRecording } = useStore();

  return (
    <aside className="w-16 h-full flex flex-col items-center py-4 gap-2 border-r border-border bg-surface">
      {/* Logo / brand */}
      <div className="w-9 h-9 rounded-lg bg-accent/20 flex items-center justify-center mb-4">
        <Headphones className="w-5 h-5 text-accent" />
      </div>

      {/* Record button */}
      <button
        onClick={startRecording}
        aria-label={isRecording ? "Recording in progress" : "Start recording"}
        data-testid="sidebar-record-button"
        className={clsx(
          "w-10 h-10 rounded-full flex items-center justify-center transition-all mb-4 cursor-pointer",
          isRecording
            ? "bg-recording animate-pulse shadow-lg shadow-recording/40"
            : "bg-accent hover:bg-accent-hover shadow-lg shadow-accent/20",
        )}
      >
        <Mic className="w-4 h-4 text-white" />
      </button>

      {/* Nav items */}
      <nav className="flex flex-col gap-1 flex-1">
        {navItems.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            title={label}
            onClick={() => setView(id)}
            className={clsx(
              "w-10 h-10 rounded-lg flex items-center justify-center transition-all cursor-pointer",
              view === id
                ? "bg-surface-active text-text-primary"
                : "text-text-muted hover:text-text-secondary hover:bg-surface-hover",
            )}
          >
            <Icon className="w-5 h-5" />
          </button>
        ))}
      </nav>

      {/* Status indicator */}
      <div
        className="w-2 h-2 rounded-full bg-success"
        title="Ollama connected"
      />
    </aside>
  );
}
