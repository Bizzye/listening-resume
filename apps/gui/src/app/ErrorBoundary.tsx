import { Component, type ErrorInfo, type ReactNode } from "react";
import { useStore } from "../store";

interface State {
	error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("UI crashed:", error, info.componentStack);
	}

	render() {
		if (!this.state.error) return this.props.children;
		// Outside the app's `.lr` root: wrap the fallback so the design tokens/theme apply.
		const light = useStore.getState().theme === "light";
		return (
			<div className={light ? "lr light" : "lr"}>
				<div className="boot">
					<div className="errc" style={{ maxWidth: 460 }}>
						<span className="bdg st-err">
							<span className="dt" />
							Erro
						</span>
						<span className="fw6 fs14">Algo deu errado na interface</span>
						<span className="fs13" style={{ color: "var(--tx2)" }}>
							{this.state.error.message}
						</span>
						<button
							type="button"
							className="btn2"
							style={{ marginTop: 6 }}
							onClick={() => window.location.reload()}
						>
							Recarregar
						</button>
					</div>
				</div>
			</div>
		);
	}
}
