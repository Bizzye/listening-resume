export interface AnalysisTemplate {
  id: string;
  name: string;
  userPromptTemplate: string;
  builtin?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Fixed system prompt used for all analysis templates */
export const ANALYSIS_SYSTEM_PROMPT = `Você é um especialista em resumir conteúdos de áudio/vídeo. Produza resumos claros, concisos e bem estruturados. O conteúdo pode ser uma videoaula, reunião, podcast, palestra ou qualquer outra mídia. SEMPRE responda em português brasileiro.`;

export interface AnalyzeOptions {
  template: AnalysisTemplate;
  transcript: string;
  extraPrompt?: string;
  metadata?: Record<string, string>;
}

export interface AnalyzeResult {
  content: string;
  model: string;
  provider: string;
  tokensUsed?: number;
}

export interface AnalyzerPort {
  analyze(options: AnalyzeOptions): Promise<AnalyzeResult>;
  isAvailable(): Promise<boolean>;
  readonly provider: string;
  readonly model: string;
}
