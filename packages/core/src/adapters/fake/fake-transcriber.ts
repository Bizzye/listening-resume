import { TranscriptionError } from "../../domain/errors.js";
import type { TranscriptSegment } from "../../domain/models.js";
import type {
	TranscribeOptions,
	TranscribeResult,
	TranscriberPort,
} from "../../ports/transcriber.js";
import { tryReadWavInfo } from "../../utils/wav.js";

export const FAKE_TRANSCRIPT_LINES: readonly string[] = [
	"Bom dia, pessoal. Vamos começar a gravação de teste do Listening Resume.",
	"A captura está pegando o som do computador junto com o microfone, sem cabo virtual.",
	"O primeiro ponto da pauta é o cronograma de entregas do próximo trimestre.",
	"Ficou decidido que a Carla revisa o documento de requisitos até sexta-feira.",
	"Sobre o orçamento, precisamos da aprovação do financeiro antes de contratar.",
	"Um risco levantado foi a dependência do time de infraestrutura para o deploy.",
	"A entropia mede o número de microestados compatíveis com o macroestado do sistema.",
	"Em um sistema isolado, a entropia nunca diminui: esse é o enunciado da segunda lei.",
	"Para a próxima semana, leiam o capítulo vinte e tragam as dúvidas da lista oito.",
	"Encerrando o teste — vamos ver a transcrição e gerar o resumo.",
];

export interface FakeTranscriberOptions {
	provider?: string;
	model?: string;
	segmentsPerChunk?: number;
	/** Fail every call with this message (to test error paths). */
	failWith?: string;
	rateLimited?: boolean;
	/** Artificial latency per call. */
	delayMs?: number;
}

/** Deterministic pt-BR transcriber: N evenly spaced segments per chunk, cycling a fixed script. */
export class FakeTranscriber implements TranscriberPort {
	readonly provider: string;
	readonly model: string;
	readonly rateLimited: boolean;
	/** Audio paths received, in order. */
	readonly calls: string[] = [];
	failWith: string | undefined;

	private readonly segmentsPerChunk: number;
	private readonly delayMs: number;

	constructor(options: FakeTranscriberOptions = {}) {
		this.provider = options.provider ?? "fake";
		this.model = options.model ?? "fake-whisper";
		this.rateLimited = options.rateLimited ?? false;
		this.segmentsPerChunk = Math.max(1, options.segmentsPerChunk ?? 3);
		this.failWith = options.failWith;
		this.delayMs = options.delayMs ?? 0;
	}

	async transcribe(audioPath: string, options?: TranscribeOptions): Promise<TranscribeResult> {
		const call = this.calls.length;
		this.calls.push(audioPath);
		if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
		if (this.failWith) throw new TranscriptionError(this.failWith);

		const duration = tryReadWavInfo(audioPath)?.durationSec ?? 30;
		const step = duration / this.segmentsPerChunk;
		const segments: TranscriptSegment[] = [];
		for (let i = 0; i < this.segmentsPerChunk; i++) {
			const line =
				FAKE_TRANSCRIPT_LINES[(call * this.segmentsPerChunk + i) % FAKE_TRANSCRIPT_LINES.length];
			segments.push({
				start: round(i * step),
				end: round((i + 1) * step),
				text: line,
			});
		}
		return {
			segments,
			fullText: segments.map((s) => s.text).join(" "),
			language: options?.language && options.language !== "auto" ? options.language : "pt",
			duration,
		};
	}
}

function round(v: number): number {
	return Math.round(v * 100) / 100;
}
