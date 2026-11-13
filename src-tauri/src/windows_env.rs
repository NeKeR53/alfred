//! `PATH` tel que Windows l’enregistre, pour l’utilisateur puis pour le poste. Une application ouverte depuis le
//! menu Démarrer garde le `PATH` de l’ouverture de session : un CLI installé depuis n’y est pas, mais il est déjà
//! dans le registre.
use std::ptr;

use windows_sys::Win32::{
    Foundation::ERROR_SUCCESS,
    System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    },
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Valeur texte du registre, sans expansion des `%VARIABLE%`.
fn read_string(root: HKEY, key: &str, name: &str) -> Option<String> {
    let (key, name) = (wide(key), wide(name));
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    let mut bytes: u32 = 0;
    // SAFETY: Size query: null data pointer with a valid size out-parameter and NUL-terminated names.
    let status =
        unsafe { RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, ptr::null_mut(), ptr::null_mut(), &mut bytes) };
    if status != ERROR_SUCCESS || bytes == 0 {
        return None;
    }
    let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2) + 1];
    let mut size = (buffer.len() * 2) as u32;
    // SAFETY: `buffer` holds `size` writable bytes; the API writes at most that many and reports the length.
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size)
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..length]))
}

/// `PATH` enregistré de l’utilisateur puis du poste, sans expansion.
pub(crate) fn registered_path() -> Vec<String> {
    [
        (HKEY_CURRENT_USER, "Environment"),
        (HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    ]
    .into_iter()
    .filter_map(|(root, key)| read_string(root, key, "Path"))
    .collect()
}
