import type { Analysis, AnalysisTemplate, Session, Transcript } from "../domain/models.js";

export interface ExportData {
	session: Session;
	transcript: Transcript | null;
	analyses: Analysis[];
	/** Used to title analyses with their template name (built-ins are resolved anyway). */
	templates?: AnalysisTemplate[];
	/** Total audio duration in seconds (from WAV headers), if known. */
	durationSec?: number;
}

export interface ExporterPort {
	readonly format: string;
	/** Returns the formatted document. */
	export(data: ExportData): Promise<string>;
}
