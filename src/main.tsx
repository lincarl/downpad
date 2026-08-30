import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createAppStore } from "./app/createAppStore";
import "./styles/app.css";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) throw new Error("Missing #app mount point");

createRoot(root).render(
  <StrictMode>
    <App store={createAppStore()} />
  </StrictMode>,
);
