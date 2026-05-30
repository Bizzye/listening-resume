import { useEffect } from "react";
import { useStore } from "./store";
import { ErrorBoundary } from "./shared/ErrorBoundary";
import { Sidebar } from "./features/navigation/Sidebar";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { RecordingPage } from "./features/recording/RecordingPage";
import { SessionsPage } from "./features/sessions/SessionsPage";
import { SessionDetailPage } from "./features/sessions/SessionDetailPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TemplatesPage } from "./features/settings/TemplatesPage";
import { X } from "lucide-react";

export default function App() {
  const { view, isRecording, error, clearError, init } = useStore();

  useEffect(() => {
    init();
  }, [init]);

  return (
    <ErrorBoundary>
      <div className="h-screen w-screen flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          {isRecording ? (
            <RecordingPage />
          ) : view === "dashboard" ? (
            <DashboardPage />
          ) : view === "sessions" ? (
            <SessionsPage />
          ) : view === "session" ? (
            <SessionDetailPage />
          ) : view === "settings" ? (
            <SettingsPage />
          ) : view === "templates" ? (
            <TemplatesPage />
          ) : (
            <DashboardPage />
          )}
        </main>

        {/* Error toast */}
        {error && (
          <div className="fixed bottom-4 right-4 max-w-sm bg-recording/10 border border-recording/30 rounded-lg p-3 flex items-start gap-2 animate-in">
            <p className="text-sm text-recording flex-1">{error}</p>
            <button
              onClick={clearError}
              className="text-recording/60 hover:text-recording cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
