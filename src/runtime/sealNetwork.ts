/**
 * Retire du cadre les interfaces qui joignent le réseau sans passer par la politique de sécurité du document
 * (WebRTC ne relève pas de `connect-src`). C’est une défense d’appoint : le verrou complet est dans la webview.
 * À appeler avant de charger le code d’un module.
 */
const NETWORK_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceCandidate",
  "RTCSessionDescription",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "WebTransport",
] as const;

export function sealNetwork(target: Window & typeof globalThis = window) {
  for (const name of NETWORK_GLOBALS) {
    try {
      Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // Déjà verrouillée par le navigateur : rien à retirer.
    }
  }
}
