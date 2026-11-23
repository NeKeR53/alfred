import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SocleProvider } from "socle-ui";
import "socle-ui/styles.css";
import "./styles.css";
import { App } from "./App";
import { notifications, soclePlatform, socleStorageKey } from "./shell/socle";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <SocleProvider
        density="desktop"
        platform={soclePlatform()}
        storageKey={socleStorageKey}
        notifications={notifications}
      >
        <App />
      </SocleProvider>
    </StrictMode>,
  );
}
