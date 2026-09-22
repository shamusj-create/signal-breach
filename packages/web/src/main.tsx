import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ReplayViewer } from "./ReplayViewer.tsx";
import "./styles.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  rootEl.textContent = "";
  const mode = new URLSearchParams(window.location.search).get("mode");
  const seed = Number(new URLSearchParams(window.location.search).get("seed") ?? "4242") || 4242;
  const mission = Number(new URLSearchParams(window.location.search).get("mission") ?? "0") || 0;
  const tree = mode === "replay" ? <ReplayViewer mission={mission} seed={seed} /> : <App />;
  createRoot(rootEl).render(<StrictMode>{tree}</StrictMode>);
}
