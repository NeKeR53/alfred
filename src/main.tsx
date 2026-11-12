import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@alfred/ui";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
