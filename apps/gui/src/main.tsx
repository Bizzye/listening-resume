import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled (not Google Fonts) so the desktop app renders correctly offline.
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-600.css";
import "@fontsource/geist-mono/latin-700.css";
import { App } from "./app/App";
import "./styles/tokens.css";
import "./styles/atomics.css";
import "./styles/design.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
