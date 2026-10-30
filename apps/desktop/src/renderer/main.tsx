import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { setApi, ToastProvider } from "@converge/ui";
import type { ConvergeApi } from "@converge/core/api";
import "@converge/ui/styles.css";
import "./ide/ide.css";
import "./ide/panels.css";

setApi((window as unknown as { converge: ConvergeApi }).converge);

document.documentElement.classList.add(`platform-${navigator.userAgent.includes("Mac") ? "darwin" : "other"}`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
