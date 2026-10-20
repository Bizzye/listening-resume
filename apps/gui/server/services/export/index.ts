import { buildExportDocument, type ExportData, renderMarkdown } from "@listening-resume/core";
import { badRequest } from "../../http.js";
import { renderDocx } from "./docx.js";
import { renderPdf } from "./pdf.js";
import { toRenderDoc } from "./render-doc.js";

export type ExportFormat = "md" | "pdf" | "docx";

const CONTENT_TYPES: Record<ExportFormat, string> = {
	md: "text/markdown; charset=utf-8",
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function parseExportFormat(value: string): ExportFormat {
	const v = value.trim().toLowerCase();
	if (v === "markdown") return "md";
	if (v === "md" || v === "pdf" || v === "docx") return v;
	throw badRequest('Formato inválido (use "md", "pdf" ou "docx")');
}

export interface RenderedExport {
	body: Buffer;
	contentType: string;
	/** `2026-10-11_Título.pdf` */
	filename: string;
}

/** Render a session export. All formats come from the same core `ExportDocument`. */
export async function renderExport(
	format: ExportFormat,
	data: ExportData,
): Promise<RenderedExport> {
	const doc = buildExportDocument(data);
	let body: Buffer;
	if (format === "md") body = Buffer.from(renderMarkdown(doc), "utf-8");
	else if (format === "pdf") body = await renderPdf(toRenderDoc(doc));
	else body = await renderDocx(toRenderDoc(doc));
	return { body, contentType: CONTENT_TYPES[format], filename: `${doc.fileBaseName}.${format}` };
}
