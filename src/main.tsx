import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SocleProvider } from "socle-ui";
import "socle-ui/styles.css";
import "./styles.css";
import { App } from "./App";
import { accentColor } from "./runtime/accent";
import { notifications, soclePlatform, socleStorageKey } from "./shell/socle";
import { useShell } from "./shell/store";

/** Racine : `SocleProvider` reçoit l’accent de l’espace ouvert, comme le cadre de chaque page. */
function Root() {
  const accent = useShell((state) => accentColor(state.snapshot?.accent));
  return (
    <SocleProvider
      accent={accent}
      density="desktop"
      platform={soclePlatform()}
      storageKey={socleStorageKey}
      notifications={notifications}
    >
      <App />
    </SocleProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
