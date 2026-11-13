//! Réglages de la webview que la politique de sécurité d’un document ne couvre pas. WebRTC ne relève pas de
//! `connect-src` : un cadre isolé pourrait joindre un serveur STUN ou TURN de son choix et y faire sortir des données.
//! Couper WebRTC dans le code de la page ne suffit pas (un cadre enfant `about:blank` en retrouve un exemplaire
//! neuf) : on le coupe dans la webview elle-même, pour tous les documents qu’elle affiche.

#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;

/// Coupe `RTCPeerConnection` dans les préférences d’une WKWebView. Renvoie vrai si WebRTC est bien coupé.
///
/// # Safety
/// `preferences` doit désigner un objet `WKPreferences` vivant.
#[cfg(target_os = "macos")]
pub unsafe fn disable_peer_connections(preferences: *mut AnyObject) -> bool {
    use objc2::{msg_send, sel};
    let Some(preferences) = (unsafe { preferences.as_ref() }) else { return false };
    let available: bool = unsafe { msg_send![preferences, respondsToSelector: sel!(_setPeerConnectionEnabled:)] };
    if !available {
        return false;
    }
    unsafe {
        let _: () = msg_send![preferences, _setPeerConnectionEnabled: false];
        let enabled: bool = msg_send![preferences, _peerConnectionEnabled];
        !enabled
    }
}

/// Coupe WebRTC dans la webview de la fenêtre. Sous Windows, c’est l’argument de WebView2 posé dans
/// `tauri.conf.json` (`additionalBrowserArgs`) qui s’en charge ; WebKitGTK l’a coupé par défaut.
pub fn harden(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let result = window.with_webview(|webview| {
            use objc2::msg_send;
            let view = webview.inner().cast::<AnyObject>();
            // SAFETY : `inner` est la WKWebView de la fenêtre, vivante pendant l’appel.
            let disabled = unsafe {
                let Some(view) = view.as_ref() else { return };
                let configuration: *mut AnyObject = msg_send![view, configuration];
                let Some(configuration) = configuration.as_ref() else { return };
                let preferences: *mut AnyObject = msg_send![configuration, preferences];
                disable_peer_connections(preferences)
            };
            if !disabled {
                log::error!("WebRTC n’a pas pu être coupé dans la webview : les cadres isolés pourraient joindre le réseau.");
            }
        });
        if let Err(error) = result {
            log::error!("webview inaccessible, WebRTC non coupé : {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    /// L’argument WebView2 qui coupe WebRTC hors proxy est bien dans la configuration de la fenêtre, avec ceux que
    /// Tauri pose par défaut (les remplacer sans eux les retirerait).
    #[test]
    fn windows_webview_blocks_webrtc() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json lisible");
        let args = config["app"]["windows"][0]["additionalBrowserArgs"].as_str().unwrap_or_default();
        assert!(args.contains("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"), "{args}");
        assert!(args.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"), "{args}");
    }

    /// Sur macOS, la préférence native existe dans le WebKit du système (créer une vraie WKWebView demande une
    /// application ; on vérifie la méthode sur la classe), et la fonction appelée au démarrage la coupe.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_webview_turns_peer_connections_off() {
        use std::sync::atomic::{AtomicBool, Ordering};

        use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObject, Sel};
        use objc2::{msg_send, sel, ClassType};

        #[link(name = "WebKit", kind = "framework")]
        unsafe extern "C" {}

        let webkit = AnyClass::get(c"WKPreferences").expect("WebKit chargé");
        assert!(webkit.instance_method(sel!(_setPeerConnectionEnabled:)).is_some(), "réglage WebRTC absent de WebKit");
        assert!(webkit.instance_method(sel!(_peerConnectionEnabled)).is_some());

        // Faux `WKPreferences` : WebRTC actif tant qu’on ne l’a pas coupé.
        static ENABLED: AtomicBool = AtomicBool::new(true);
        extern "C-unwind" fn set(_: &AnyObject, _: Sel, value: Bool) {
            ENABLED.store(value.as_bool(), Ordering::SeqCst);
        }
        extern "C-unwind" fn get(_: &AnyObject, _: Sel) -> Bool {
            Bool::new(ENABLED.load(Ordering::SeqCst))
        }
        let mut builder = ClassBuilder::new(c"AlfredFakePreferences", NSObject::class()).unwrap();
        unsafe {
            builder.add_method(sel!(_setPeerConnectionEnabled:), set as extern "C-unwind" fn(_, _, _));
            builder.add_method(sel!(_peerConnectionEnabled), get as extern "C-unwind" fn(_, _) -> _);
        }
        let fake = builder.register();
        unsafe {
            let preferences: *mut AnyObject = msg_send![fake, new];
            assert!(super::disable_peer_connections(preferences));
            assert!(!ENABLED.load(Ordering::SeqCst));
            let plain: *mut AnyObject = msg_send![NSObject::class(), new];
            assert!(!super::disable_peer_connections(plain), "sans le réglage, l’échec est signalé");
            let _: () = msg_send![preferences, release];
            let _: () = msg_send![plain, release];
        }
    }
}
