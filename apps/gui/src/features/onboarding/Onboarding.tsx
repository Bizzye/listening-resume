import { useCallback, useEffect, useState } from "react";
import {
	type AudioDevice,
	type ResolvedDevices,
	type Settings,
	SYSTEM_DEFAULT_DEVICE,
} from "../../shared/api/types";
import { useAudioLevels } from "../../shared/hooks/useAudioLevels";
import {
	type DeviceKind,
	deviceLabel,
	deviceOptions,
	toSelectValue,
} from "../../shared/lib/devices";
import { Icon } from "../../shared/ui/Icon";
import { LevelBars } from "../../shared/ui/LevelBars";
import { Logo } from "../../shared/ui/Logo";
import { useStore } from "../../store";
import { meterBarHeight } from "../recording/waveform";

type Provider = Settings["transcriptionProvider"];

function ModeStep({ next }: { next: () => void }) {
	const settings = useStore((s) => s.settings);
	const groqKey = useStore((s) => s.groqKey);
	const { updateSettings, saveGroqKey } = useStore.getState();
	// First run: the recommended (free, local) option is preselected, like the design.
	const [mode, setMode] = useState<Provider>("whisper-cpp");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);

	const proceed = async () => {
		setBusy(true);
		try {
			if (mode === "groq" && key.trim() && !(await saveGroqKey(key))) return;
			if (await updateSettings({ transcriptionProvider: mode })) next();
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<div className="col ac tc">
				<Logo large />
				<h1 className="h1" style={{ marginTop: 16, fontSize: 24 }}>
					Listening Resume
				</h1>
				<p className="sub" style={{ maxWidth: 390 }}>
					Grave, transcreva e entenda qualquer áudio do seu computador.
				</p>
			</div>
			<span className="lbl">Como você quer transcrever?</span>
			<div className="col gap10">
				<button
					type="button"
					className={mode === "whisper-cpp" ? "mode on" : "mode"}
					aria-pressed={mode === "whisper-cpp"}
					data-testid="onboarding-mode-whisper"
					onClick={() => setMode("whisper-cpp")}
				>
					<div className="fx jb ac">
						<b>Whisper</b>
						<span className="bdg st-ok">Recomendado</span>
					</div>
					<p>Transcrição gratuita com Whisper, sem precisar de chave de API.</p>
					<span className="mode-m">whisper.cpp · {settings?.whisperModel ?? "medium"} · pt</span>
				</button>
				<button
					type="button"
					className={mode === "groq" ? "mode on" : "mode"}
					aria-pressed={mode === "groq"}
					data-testid="onboarding-mode-groq"
					onClick={() => setMode("groq")}
				>
					<div className="fx jb ac">
						<b>Groq</b>
						<span className="bdg st-n">Requer chave</span>
					</div>
					<p>Transcrição quase instantânea. Traga sua própria chave de API.</p>
					<span className="mode-m">whisper-large-v3-turbo</span>
				</button>
				{mode === "groq" && !groqKey.configured ? (
					<input
						className="inp w100 mono"
						type="password"
						autoComplete="off"
						placeholder="Cole sua chave gsk_… (opcional agora)"
						aria-label="Chave de API do Groq"
						data-testid="onboarding-groq-key"
						value={key}
						onChange={(e) => setKey(e.target.value)}
					/>
				) : null}
			</div>
			<button
				type="button"
				className="btn"
				style={{ marginTop: 22, justifyContent: "center" }}
				data-testid="onboarding-next"
				disabled={busy}
				onClick={() => void proceed()}
			>
				Continuar
			</button>
		</>
	);
}

function Meter({
	title,
	getLevel,
	max,
	connected,
	unavailable,
	device,
	testId,
}: {
	title: string;
	getLevel: () => number;
	max: number;
	connected: boolean;
	unavailable: string | null;
	device: string;
	testId: string;
}) {
	const height = useCallback((l: number, i: number) => meterBarHeight(l, i, max), [max]);
	return (
		<div className="mtr card" data-testid={testId}>
			<div className="fx jb ac">
				<span className="fw6 fs13">{title}</span>
				{unavailable ? (
					<span className="bdg st-err">
						<span className="dt" />
						Indisponível
					</span>
				) : connected ? (
					<span className="bdg st-ok">
						<span className="dt pulse" />
						Captando
					</span>
				) : (
					<span className="bdg st-n">
						<span className="dt" />
						Conectando…
					</span>
				)}
			</div>
			<div style={{ height: 40, display: "flex", alignItems: "center", overflow: "hidden" }}>
				<LevelBars count={44} getLevel={getLevel} height={height} barWidth={3} gap={3} />
			</div>
			<span className="mode-m">{device}</span>
			{unavailable ? (
				<span className="hint" role="alert">
					{unavailable}
				</span>
			) : null}
		</div>
	);
}

/** Picker label of the configured device ("Padrão do sistema (<nome>)" or the device name). */
export function meterDeviceLabel(
	devices: AudioDevice[],
	kind: DeviceKind,
	value: string | null,
	liveName: string | null | undefined,
): string {
	const live = value === SYSTEM_DEFAULT_DEVICE ? liveName : null;
	return (
		deviceOptions(devices, kind, live).find((o) => o.value === toSelectValue(value))?.label ??
		deviceLabel(devices, value)
	);
}

/** "<device> · 16 kHz" when the server reports the recording rate, else just the device. */
export function meterCaption(device: string, sampleRate: number | undefined): string {
	return sampleRate ? `${device} · ${Math.round(sampleRate / 100) / 10} kHz` : device;
}

function TestStep({ back, next }: { back: () => void; next: () => void }) {
	const settings = useStore((s) => s.settings);
	const devices = useStore((s) => s.devices);
	const sampleRate = useStore((s) => s.health?.services.capture.sampleRate);
	const [live, setLive] = useState<ResolvedDevices | null>(null);
	const system = settings?.systemDevice ?? SYSTEM_DEFAULT_DEVICE;
	const mic = settings ? settings.micDevice : SYSTEM_DEFAULT_DEVICE;
	const { read, connected, unavailable } = useAudioLevels({ system, mic, onDevices: setLive });
	const getSys = useCallback(() => read().system, [read]);
	const getMic = useCallback(() => read().mic, [read]);

	useEffect(() => {
		void useStore.getState().loadDevices();
	}, []);

	const label = (kind: DeviceKind, value: string | null, liveName: string | null | undefined) =>
		meterCaption(meterDeviceLabel(devices, kind, value, liveName), sampleRate);

	return (
		<>
			<h2 className="h2" style={{ fontSize: 19 }}>
				Vamos testar seu áudio
			</h2>
			<p className="sub" style={{ marginBottom: 18 }}>
				Toque qualquer som no computador e fale algo — as barras devem se mexer.
			</p>
			<div className="col gap10">
				<Meter
					title="Áudio do sistema"
					getLevel={getSys}
					max={34}
					connected={connected}
					unavailable={unavailable}
					device={label("system", system, live?.systemName)}
					testId="meter-system"
				/>
				{mic === null ? (
					<div className="mtr card">
						<div className="fx jb ac">
							<span className="fw6 fs13">Microfone</span>
							<span className="bdg st-n">Sem microfone</span>
						</div>
						<span className="mode-m">Ative um microfone em Configurações → Áudio.</span>
					</div>
				) : (
					<Meter
						title="Microfone"
						getLevel={getMic}
						max={22}
						connected={connected}
						unavailable={unavailable}
						device={label("mic", mic, live?.micName)}
						testId="meter-mic"
					/>
				)}
			</div>
			<div className="fx jb ac" style={{ marginTop: 22 }}>
				<button type="button" className="ghost" data-testid="onboarding-back" onClick={back}>
					Voltar
				</button>
				<button type="button" className="btn" data-testid="onboarding-next" onClick={next}>
					Está funcionando
				</button>
			</div>
		</>
	);
}

function DoneStep({ finish }: { finish: () => void }) {
	return (
		<div className="col ac tc gap10">
			<div className="okc">
				<Icon name="check" size={28} />
			</div>
			<h2 className="h2" style={{ fontSize: 20 }}>
				Tudo pronto.
			</h2>
			<p className="sub" style={{ maxWidth: 370 }}>
				Grave qualquer aula, reunião ou podcast com um atalho.
			</p>
			<div className="fx ac gap6" style={{ marginTop: 10 }}>
				<span className="kbd">Ctrl</span>
				<span className="kbd">Shift</span>
				<span className="kbd">R</span>
				<span className="hint" style={{ marginLeft: 6 }}>
					inicia uma gravação de qualquer lugar
				</span>
			</div>
			<button
				type="button"
				className="btn"
				style={{ marginTop: 20 }}
				data-testid="onboarding-finish"
				onClick={finish}
			>
				Começar a usar
			</button>
		</div>
	);
}

/** First-run flow, shown while `settings.onboardingDone` is false. */
export function Onboarding() {
	const [step, setStep] = useState(0);
	const { updateSettings, pop } = useStore.getState();
	const finish = async () => {
		if (await updateSettings({ onboardingDone: true }))
			pop("Bem-vindo! Ctrl+Shift+R inicia uma gravação.", "ac");
	};
	const skip = () => void updateSettings({ onboardingDone: true });

	return (
		<div className="ob" data-screen-label="Onboarding" data-testid="onboarding">
			<div className="ob-glow" />
			<div className="ob-box card">
				{step === 0 ? <ModeStep next={() => setStep(1)} /> : null}
				{step === 1 ? <TestStep back={() => setStep(0)} next={() => setStep(2)} /> : null}
				{step === 2 ? <DoneStep finish={() => void finish()} /> : null}
				<div className="dts">
					<span className="sr-only">{`Passo ${step + 1} de 3`}</span>
					{[0, 1, 2].map((i) => (
						<span key={i} className={step === i ? "dt2 on" : "dt2"} />
					))}
				</div>
				<div className="tc" style={{ marginTop: 8 }}>
					<button
						type="button"
						className="ghost"
						style={{ fontSize: 12 }}
						data-testid="onboarding-skip"
						onClick={skip}
					>
						Pular introdução
					</button>
				</div>
			</div>
		</div>
	);
}
