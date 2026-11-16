#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Extraction du texte d’un PDF, isolée dans son propre processus : voir `documents::pdf_pages`.
    if std::env::args().nth(1).as_deref() == Some(alfred_lib::EXTRACT_PDF_FLAG) {
        std::process::exit(alfred_lib::extract_pdf_from_stdin());
    }
    alfred_lib::run();
}
