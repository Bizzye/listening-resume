import type { Analysis, Session, Transcript } from "../domain/models.js";

export interface ExportData {
  session: Session;
  transcript: Transcript | null;
  analyses: Analysis[];
}

export interface ExporterPort {
  export(data: ExportData): Promise<string>; // returns formatted content
  readonly format: string;
}
