import { type ComponentProps, type ReactNode, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import type { Analysis } from "../../shared/api/types";
import { openExternal, safeExternalUrl } from "../../shared/lib/external";
import { analysisBlocks, type Flashcard, type SectionBlock } from "./analysisMarkdown";

/** Links in model output open outside the app (system browser), never inside the webview. */
function ExternalLink({ href, children }: ComponentProps<"a">) {
	const url = safeExternalUrl(href);
	if (!url) return <span>{children}</span>;
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			onClick={(e) => {
				e.preventDefault();
				void openExternal(url);
			}}
		>
			{children}
		</a>
	);
}

const BLOCK_COMPONENTS: Components = { a: ExternalLink };
const INLINE_COMPONENTS: Components = {
	a: ExternalLink,
	p: ({ children }: { children?: ReactNode }) => <>{children}</>,
};

/** Inline Markdown (bold, code, links) without wrapping paragraphs. */
function InlineMd({ text }: { text: string }) {
	return <Markdown components={INLINE_COMPONENTS}>{text}</Markdown>;
}

function SectionTitle({ title }: { title: string }) {
	return <h3 className="an-h">{title}</h3>;
}

function FlipCard({ card }: { card: Flashcard }) {
	const [flipped, setFlipped] = useState(false);
	return (
		<button
			type="button"
			className={flipped ? "fc on" : "fc"}
			aria-pressed={flipped}
			aria-label={flipped ? `Resposta: ${card.back}` : `Pergunta: ${card.front}`}
			data-testid="flashcard"
			onClick={() => setFlipped((f) => !f)}
		>
			<div className="fc-in">
				<div className="fc-f">{card.front}</div>
				<div className="fc-b">{card.back}</div>
			</div>
		</button>
	);
}

function Block({ block, fallbackTitle }: { block: SectionBlock; fallbackTitle: string }) {
	const title = block.title ?? fallbackTitle;
	switch (block.kind) {
		case "flashcards":
			return (
				<div className="an-sec">
					<div className="fx jb ac" style={{ marginBottom: 12 }}>
						<h3 className="an-h" style={{ margin: 0 }}>
							{title}
						</h3>
						<span className="hint">clique para virar · exporte para o Anki</span>
					</div>
					<div className="grid2">
						{block.cards.map((c, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: parsed once per analysis, never reordered
							<FlipCard key={i} card={c} />
						))}
					</div>
				</div>
			);
		case "concepts":
			return (
				<div className="an-sec">
					<SectionTitle title={title} />
					<div className="grid2">
						{block.items.map((k, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: model output may repeat terms
							<div key={`${i}-${k.term}`} className="card kc">
								<b>{k.term}</b>
								<p>
									<InlineMd text={k.desc} />
								</p>
							</div>
						))}
					</div>
				</div>
			);
		case "formulas":
			return (
				<div className="an-sec">
					<SectionTitle title={title} />
					<div className="grid2">
						{block.items.map((f, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: model output may repeat formulas
							<div key={`${i}-${f.expr}`} className="fml">
								<span className="fml-x">{f.expr}</span>
								{f.label ? <span className="fml-l">{f.label}</span> : null}
							</div>
						))}
					</div>
				</div>
			);
		case "steps":
			return (
				<div className="an-sec">
					<SectionTitle title={title} />
					<div className="card" style={{ padding: "18px 22px" }}>
						<ol className="an-ol">
							{block.items.map((it, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: ordered list, position is identity
								<li key={i}>
									<InlineMd text={it} />
								</li>
							))}
						</ol>
					</div>
				</div>
			);
		case "glossary":
			return (
				<div className="an-sec">
					<SectionTitle title={title} />
					<div className="col">
						{block.items.map((g, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: model output may repeat terms
							<div key={`${i}-${g.term}`} className="gl">
								<b>{g.term}</b>
								<span>
									<InlineMd text={g.desc} />
								</span>
							</div>
						))}
					</div>
				</div>
			);
		default:
			return (
				<div className="an-sec">
					<SectionTitle title={title} />
					<div className="card an-md" style={{ padding: "20px 24px" }}>
						<Markdown components={BLOCK_COMPONENTS}>{block.body}</Markdown>
					</div>
				</div>
			);
	}
}

/** Renders one analysis with the design typography (`.an-sec` / `.an-h` / cards / flip cards). */
export function AnalysisView({ analysis, title }: { analysis: Analysis; title: string }) {
	const blocks = analysisBlocks(analysis.content, analysis.templateId);
	return (
		<div style={{ marginTop: 6 }} data-testid="analysis-view">
			{blocks.length ? (
				blocks.map((b, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: sections derive from immutable content
					<Block key={`${analysis.id}-${i}`} block={b} fallbackTitle={title} />
				))
			) : (
				<div className="an-sec">
					<SectionTitle title={title} />
					<div className="card" style={{ padding: "20px 24px" }}>
						<span className="hint">A análise veio vazia.</span>
					</div>
				</div>
			)}
		</div>
	);
}
