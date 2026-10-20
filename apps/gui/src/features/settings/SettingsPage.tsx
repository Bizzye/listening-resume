import { type ReactNode, useEffect, useState } from "react";
import { type Health, type Settings, SYSTEM_DEFAULT_DEVICE } from "../../shared/api/types";
import { DeviceSelect } from "../../shared/ui/DeviceSelect";
import { DirInput, usePickFolder } from "../../shared/ui/DirInput";
import { Select } from "../../shared/ui/Select";
import { Switch } from "../../shared/ui/Switch";
import { useStore } from "../../store";

function Row({
	label,
	desc,
	children,
	last,
}: {
	label: string;
	desc?: string;
	children: ReactNode;
	last?: boolean;
}) {
	return (
		<div className={last ? "set-row last" : "set-row"}>
			<div>
				<div className="set-l">{label}</div>
				{desc ? <div className="set-d">{desc}</div> : null}
			</div>
			{children}
		</div>
	);
}

const WHISPER_MODELS = [
	{ value: "small", label: "small · 466 MB" },
	{ value: "medium", label: "medium · 1.5 GB" },
	{ value: "large-v3", label: "large-v3 · 2.9 GB" },
];
const LANGUAGES = [
	{ value: "pt-BR", label: "Português (Brasil)" },
	{ value: "en", label: "English" },
];
const FORMATS = [
	{ value: "md", label: "Markdown" },
	{ value: "pdf", label: "PDF" },
	{ value: "docx", label: "DOCX" },
];

function AudioSection({ settings }: { settings: Settings }) {
	const devices = useStore((s) => s.devices);
	const { updateSettings, playTestSound } = useStore.getState();
	return (
		<div className="card set-sec">
			<div className="set-h">Áudio</div>
			<Row label="Dispositivo de captura" desc="Fonte do áudio do sistema">
				<DeviceSelect
					kind="system"
					label="Dispositivo de captura"
					devices={devices}
					value={settings.systemDevice}
					onChange={(v) => void updateSettings({ systemDevice: v ?? SYSTEM_DEFAULT_DEVICE })}
					testId="settings-system-device-select"
				/>
			</Row>
			<Row label="Microfone" desc="Mixado junto com o áudio do sistema">
				<DeviceSelect
					kind="mic"
					label="Microfone"
					devices={devices}
					value={settings.micDevice}
					onChange={(v) => void updateSettings({ micDevice: v })}
					testId="settings-mic-device-select"
				/>
			</Row>
			<Row label="Detectar silêncio" desc="Avisa quando nenhuma fonte está emitindo som">
				<Switch
					checked={settings.silenceDetection}
					onChange={(v) => void updateSettings({ silenceDetection: v })}
					label="Detectar silêncio"
					testId="switch-silence"
				/>
			</Row>
			<Row label="Testar som" desc="Toca um sinal na saída selecionada" last>
				<button
					type="button"
					className="btn2"
					data-testid="test-sound-button"
					onClick={() => void playTestSound(settings.systemDevice)}
				>
					Testar
				</button>
			</Row>
		</div>
	);
}

function TranscriptionSection({ settings }: { settings: Settings }) {
	const updateSettings = useStore((s) => s.updateSettings);
	const local = settings.transcriptionProvider === "whisper-cpp";
	return (
		<div className="card set-sec">
			<div className="set-h">Transcrição</div>
			<div className="grid2" style={{ margin: "10px 0 4px" }}>
				<button
					type="button"
					className={local ? "mode on" : "mode"}
					aria-pressed={local}
					data-testid="provider-whisper"
					onClick={() => void updateSettings({ transcriptionProvider: "whisper-cpp" })}
				>
					<div className="fx jb ac">
						<b>Whisper</b>
						<span className="bdg st-ok">Grátis</span>
					</div>
					<p>whisper.cpp no seu computador. Sem chave de API.</p>
				</button>
				<button
					type="button"
					className={!local ? "mode on" : "mode"}
					aria-pressed={!local}
					data-testid="provider-groq"
					onClick={() => void updateSettings({ transcriptionProvider: "groq" })}
				>
					<div className="fx jb ac">
						<b>Groq</b>
						<span className="bdg st-n">BYOK</span>
					</div>
					<p>whisper-large-v3-turbo. Rápido; requer chave de API.</p>
				</button>
			</div>
			<Row label="Modelo Whisper" desc="Maior = mais preciso e mais lento">
				<Select
					label="Modelo Whisper"
					value={settings.whisperModel}
					options={WHISPER_MODELS}
					onChange={(v) => void updateSettings({ whisperModel: v as Settings["whisperModel"] })}
					testId="whisper-model-select"
				/>
			</Row>
			<Row
				label="Transcrever ao parar"
				desc="Inicia a transcrição automaticamente ao fim da gravação"
				last
			>
				<Switch
					checked={settings.autoTranscribe}
					onChange={(v) => void updateSettings({ autoTranscribe: v })}
					label="Transcrever ao parar"
					testId="switch-auto-transcribe"
				/>
			</Row>
		</div>
	);
}

function GroqKeySection() {
	const groqKey = useStore((s) => s.groqKey);
	const { validateGroqKey, removeGroqKey } = useStore.getState();
	const [draft, setDraft] = useState("");
	const [show, setShow] = useState(false);
	const [busy, setBusy] = useState(false);

	const validate = async () => {
		setBusy(true);
		try {
			if (await validateGroqKey(draft.trim() || undefined)) setDraft("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card set-sec">
			<div className="set-h">Chave de API (Groq)</div>
			<div className="set-row last" style={{ gap: 12 }}>
				<input
					className="inp f1 mono"
					type={show ? "text" : "password"}
					autoComplete="off"
					spellCheck={false}
					aria-label="Chave de API do Groq"
					data-testid="groq-key-input"
					placeholder={
						groqKey.configured ? (groqKey.masked ?? "Chave configurada") : "Cole sua chave gsk_…"
					}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void validate();
					}}
				/>
				<button
					type="button"
					className="btn2"
					data-testid="groq-key-toggle"
					onClick={() => setShow((v) => !v)}
				>
					{show ? "Ocultar" : "Mostrar"}
				</button>
				<button
					type="button"
					className="btn2"
					data-testid="groq-key-validate"
					disabled={busy || (!draft.trim() && !groqKey.configured)}
					onClick={() => void validate()}
				>
					{draft.trim() ? "Salvar e validar" : "Validar"}
				</button>
				{groqKey.configured && !draft ? (
					<button
						type="button"
						className="ghost"
						style={{ color: "var(--red)" }}
						data-testid="groq-key-remove"
						onClick={() => void removeGroqKey()}
					>
						Remover
					</button>
				) : null}
			</div>
		</div>
	);
}

function AnalysisSection({ settings }: { settings: Settings }) {
	const models = useStore((s) => s.analysisModels);
	const templates = useStore((s) => s.templates);
	const updateSettings = useStore((s) => s.updateSettings);
	const modelOpts = (
		models.includes(settings.analysisModel) ? models : [settings.analysisModel, ...models]
	).map((m) => ({
		value: m,
		label: m,
	}));
	const tplOpts = templates.map((t) => ({ value: t.id, label: t.name }));
	if (!tplOpts.some((o) => o.value === settings.defaultTemplateId))
		tplOpts.unshift({ value: settings.defaultTemplateId, label: settings.defaultTemplateId });
	return (
		<div className="card set-sec">
			<div className="set-h">Análise</div>
			<Row
				label="Modelo"
				desc={
					models.length ? "Servido pelo Ollama" : "Servido pelo Ollama (nenhum modelo encontrado)"
				}
			>
				<Select
					label="Modelo de análise"
					value={settings.analysisModel}
					options={modelOpts}
					onChange={(v) => void updateSettings({ analysisModel: v })}
					testId="analysis-model-select"
				/>
			</Row>
			<Row label="Template padrão" desc="Pré-selecionado ao gerar uma análise">
				<Select
					label="Template padrão"
					value={settings.defaultTemplateId}
					options={tplOpts}
					onChange={(v) => void updateSettings({ defaultTemplateId: v })}
					testId="default-template-select"
				/>
			</Row>
			<Row label="Idioma das análises" last>
				<Select
					label="Idioma das análises"
					value={settings.analysisLanguage}
					options={LANGUAGES}
					onChange={(v) =>
						void updateSettings({ analysisLanguage: v as Settings["analysisLanguage"] })
					}
					testId="analysis-language-select"
				/>
			</Row>
		</div>
	);
}

function ExportSection({ settings }: { settings: Settings }) {
	const updateSettings = useStore((s) => s.updateSettings);
	const pop = useStore((s) => s.pop);
	const folder = usePickFolder();
	return (
		<div className="card set-sec">
			<div className="set-h">Export</div>
			<div className="set-row" style={{ gap: 12 }}>
				<div style={{ flex: "none" }}>
					<div className="set-l">Pasta padrão</div>
					<div className="set-d">
						Usada por todas as sessões, a menos que uma sessão defina a sua
					</div>
				</div>
				<div style={{ display: "flex", gap: 8, flex: 1, maxWidth: 460 }}>
					<DirInput
						value={settings.exportDir}
						label="Pasta padrão de export"
						testId="export-dir-global-input"
						inputRef={folder.ref}
						onCommit={async (v) => {
							if (await updateSettings({ exportDir: v })) pop(`Pasta padrão: ${v}`, "ac");
						}}
					/>
					<button
						type="button"
						className="btn2"
						style={{ padding: "8px 12px" }}
						onClick={folder.pick}
					>
						Escolher pasta…
					</button>
				</div>
			</div>
			<Row label="Formato padrão" last>
				<Select
					label="Formato padrão"
					value={settings.exportFormat}
					options={FORMATS}
					onChange={(v) => void updateSettings({ exportFormat: v as Settings["exportFormat"] })}
					testId="export-format-select"
				/>
			</Row>
		</div>
	);
}

export interface ServiceRow {
	key: string;
	label: string;
	detail: string;
	tone: "ok" | "err" | "amb";
}

/** Groq row detail: "conectado" after a successful validation in this run. */
export function groqStatus(
	configured: boolean,
	validated: boolean,
): Pick<ServiceRow, "detail" | "tone"> {
	if (!configured) return { detail: "sem chave", tone: "amb" };
	return validated
		? { detail: "conectado", tone: "ok" }
		: { detail: "chave não validada", tone: "amb" };
}

export function serviceRows(
	health: Health | null,
	settings: Settings,
	groqValidated = false,
): ServiceRow[] {
	if (!health)
		return [{ key: "server", label: "Serviço local", detail: "indisponível", tone: "err" }];
	const s = health.services;
	let port = "";
	try {
		port = new URL(s.ollama.url).port;
	} catch {
		// keep empty
	}
	return [
		{
			key: "ollama",
			label: `Ollama · ${settings.analysisModel || s.ollama.model}`,
			detail: s.ollama.ok ? `conectado${port ? ` · :${port}` : ""}` : "offline",
			tone: s.ollama.ok ? "ok" : "err",
		},
		{
			key: "whisper",
			label: `Whisper · ${s.whisper.model}`,
			detail: s.whisper.ok ? "pronto" : "indisponível",
			tone: s.whisper.ok ? "ok" : settings.transcriptionProvider === "whisper-cpp" ? "err" : "amb",
		},
		{
			key: "ffmpeg",
			label: "FFmpeg",
			detail: s.ffmpeg.ok ? (s.ffmpeg.version ?? "instalado") : "não encontrado",
			tone: s.ffmpeg.ok ? "ok" : "err",
		},
		{
			key: "capture",
			label: `Captura de áudio · ${s.capture.backend}`,
			detail: s.capture.ok ? "pronta" : "indisponível",
			tone: s.capture.ok ? "ok" : "err",
		},
		{ key: "groq", label: "Groq API", ...groqStatus(s.groq.configured, groqValidated) },
	];
}

function StatusSection({ settings }: { settings: Settings }) {
	const health = useStore((s) => s.health);
	const groqValidated = useStore((s) => s.groqValidated);
	const rows = serviceRows(health, settings, groqValidated);
	return (
		<div className="card set-sec" data-testid="service-status">
			<div className="set-h">Status dos serviços</div>
			{rows.map((r, i) => (
				<div
					key={r.key}
					className={i === rows.length - 1 ? "set-row last" : "set-row"}
					data-testid={`service-${r.key}`}
				>
					<span className="stt">
						<span
							className={r.tone === "amb" ? "tdot" : `tdot k-${r.tone}`}
							style={r.tone === "amb" ? { background: "var(--amb)" } : undefined}
						/>
						{r.label}
					</span>
					<span className="hint mono">{r.detail}</span>
				</div>
			))}
		</div>
	);
}

export function SettingsPage() {
	const settings = useStore((s) => s.settings);
	const pop = useStore((s) => s.pop);
	useEffect(() => {
		const { loadDevices, loadAnalysisModels, loadGroqKey, loadHealth } = useStore.getState();
		void loadDevices();
		void loadAnalysisModels();
		void loadGroqKey();
		void loadHealth();
	}, []);
	if (!settings) return null;
	return (
		<div className="pg" data-screen-label="Configurações">
			<h1 className="h1">Configurações</h1>
			<p className="sub">Áudio, transcrição, análise e export.</p>
			<AudioSection settings={settings} />
			<TranscriptionSection settings={settings} />
			<GroqKeySection />
			<AnalysisSection settings={settings} />
			<ExportSection settings={settings} />
			<StatusSection settings={settings} />
			<div className="pro">
				<div>
					<div className="fw7 fs15">Listening Resume Pro</div>
					<p className="sub" style={{ maxWidth: 420 }}>
						Templates ilimitados, exportação para Anki, e transcrição em lote.
					</p>
				</div>
				<button type="button" className="btn" onClick={() => pop("Licença Pro — em breve", "ac")}>
					Ativar licença
				</button>
			</div>
		</div>
	);
}
