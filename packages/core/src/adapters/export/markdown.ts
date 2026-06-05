import type { ExportData, ExporterPort } from "../../ports/exporter.js";

export class MarkdownExporter implements ExporterPort {
	readonly format = "markdown";

	async export(data: ExportData): Promise<string> {
		const lines: string[] = [];

		lines.push(`# ${data.session.title ?? "Session"}`);
		lines.push("");
		lines.push(`**Date**: ${data.session.startedAt ?? data.session.createdAt}`);
		lines.push(`**Status**: ${data.session.status}`);
		lines.push(`**Source**: ${data.session.audioSource ?? "unknown"}`);
		lines.push("");

		if (data.transcript) {
			lines.push("## Transcription");
			lines.push("");

			for (const segment of data.transcript.segments) {
				const timestamp = formatTimestamp(segment.start);
				lines.push(`**[${timestamp}]** ${segment.text}`);
				lines.push("");
			}

			lines.push("---");
			lines.push("");
		}

		for (const analysis of data.analyses) {
			lines.push(`## ${analysis.templateId}`);
			lines.push("");
			lines.push(analysis.content);
			lines.push("");
			lines.push("---");
			lines.push("");
		}

		return lines.join("\n");
	}
}

function formatTimestamp(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) {
		return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	}
	return `${m}:${String(s).padStart(2, "0")}`;
}
