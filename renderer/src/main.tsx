import "./bootSplash"; // first: takes over the launch screen index.html painted, before the app modules evaluate
import "./mockBridge"; // dev-only browser demo: installs a stub window.threadterm when the Electron preload is absent
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { installContextMenuFallback } from "./contextMenuFallback";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
installContextMenuFallback();
