//! Documents des modules : produire un PDF, un CSV ou un classeur Excel à partir de données, et lire le texte d’un
//! PDF ou d’un document Word reçu. Les documents produits deviennent des fichiers du module (`module_files.rs`).
//!
//! Le PDF est écrit ici, sans dépendance : police Helvetica du lecteur (aucune police à embarquer), encodage
//! WinAnsi (français compris), mise en page en blocs (titres, paragraphes, listes, tableaux) sur des pages A4.

use std::io::Read;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::module_files::{self, FileInfo};
use crate::permissions::Subject;
use crate::space::Space;
use crate::state::AppState;

/// Au-delà, un texte extrait est tronqué (un livre entier n’a pas sa place dans une réponse du pont).
const MAX_TEXT: usize = 2_000_000;

// ---------------------------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Heading {
        text: String,
        #[serde(default = "one")]
        level: u8,
    },
    Paragraph {
        text: String,
    },
    List {
        items: Vec<String>,
        #[serde(default)]
        ordered: bool,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<Value>>,
        /// Largeurs relatives des colonnes ; à défaut, égales.
        #[serde(default)]
        widths: Vec<f32>,
    },
    PageBreak,
}

fn one() -> u8 {
    1
}

#[derive(Clone, Copy, PartialEq)]
enum Font {
    Regular,
    Bold,
}

/// Largeurs Helvetica (millièmes de corps) des caractères ASCII 32 à 126, police normale puis grasse.
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
    556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
    556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
    500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722,
    611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556,
    611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778,
    556, 556, 500, 389, 280, 389, 584,
];

/// Caractère dans l’encodage WinAnsi des polices standard ; `?` pour ce qu’il ne connaît pas.
fn win_ansi(c: char) -> u8 {
    match c {
        ' '..='~' => c as u8,
        '\u{a0}' | '\u{202f}' | '\u{2009}' => 0xa0,
        '\u{a1}'..='\u{ff}' => c as u32 as u8,
        '€' => 0x80,
        '‚' => 0x82,
        '„' => 0x84,
        '…' => 0x85,
        '‘' => 0x91,
        '’' => 0x92,
        '“' => 0x93,
        '”' => 0x94,
        '•' => 0x95,
        '–' => 0x96,
        '—' => 0x97,
        '™' => 0x99,
        'Š' => 0x8a,
        'Œ' => 0x8c,
        'Ž' => 0x8e,
        'š' => 0x9a,
        'œ' => 0x9c,
        'ž' => 0x9e,
        'Ÿ' => 0x9f,
        '\t' => b' ',
        _ => b'?',
    }
}

/// Lettre de base d’une lettre accentuée : même largeur dans Helvetica.
fn base_letter(byte: u8) -> u8 {
    match byte {
        0xc0..=0xc5 => b'A',
        0xc7 => b'C',
        0xc8..=0xcb => b'E',
        0xcc..=0xcf => b'I',
        0xd1 => b'N',
        0xd2..=0xd6 | 0xd8 => b'O',
        0xd9..=0xdc => b'U',
        0xdd | 0x9f => b'Y',
        0xe0..=0xe5 => b'a',
        0xe7 => b'c',
        0xe8..=0xeb => b'e',
        0xec..=0xef => b'i',
        0xf1 => b'n',
        0xf2..=0xf6 | 0xf8 => b'o',
        0xf9..=0xfc => b'u',
        0xfd | 0xff => b'y',
        0x8a => b'S',
        0x9a => b's',
        0x8e => b'Z',
        0x9e => b'z',
        _ => 0,
    }
}

fn glyph_width(byte: u8, font: Font) -> f32 {
    let table = if font == Font::Bold { &HELVETICA_BOLD } else { &HELVETICA };
    let ascii = |b: u8| f32::from(table[usize::from(b - 32)]);
    let width = match byte {
        32..=126 => ascii(byte),
        0xa0 => 278.0,
        0x80 | 0xab | 0xbb | 0x95 | 0x96 | 0xb0..=0xb1 => 556.0,
        0x85 | 0x97 | 0x8c => 1000.0,
        0x9c | 0xe6 => 944.0,
        0xc6 => 1000.0,
        0x91 | 0x92 | 0x82 => if font == Font::Bold { 278.0 } else { 222.0 },
        0x93 | 0x94 | 0x84 => if font == Font::Bold { 500.0 } else { 333.0 },
        0xdf => 611.0,
        _ => match base_letter(byte) {
            0 => 556.0,
            letter => ascii(letter),
        },
    };
    width / 1000.0
}

fn encode(text: &str) -> Vec<u8> {
    text.chars().map(win_ansi).collect()
}

fn text_width(bytes: &[u8], font: Font, size: f32) -> f32 {
    bytes.iter().map(|byte| glyph_width(*byte, font)).sum::<f32>() * size
}

/// Coupe un texte en lignes d’au plus `width` points ; un mot trop long est coupé lui-même.
fn wrap(text: &str, font: Font, size: f32, width: f32) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line: Vec<u8> = Vec::new();
        for word in paragraph.split(' ').filter(|word| !word.is_empty()) {
            let mut word = encode(word);
            let candidate_width = text_width(&line, font, size)
                + if line.is_empty() { 0.0 } else { glyph_width(b' ', font) * size }
                + text_width(&word, font, size);
            if candidate_width <= width {
                if !line.is_empty() {
                    line.push(b' ');
                }
                line.append(&mut word);
                continue;
            }
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            while text_width(&word, font, size) > width && word.len() > 1 {
                let mut cut = 1;
                while cut < word.len() && text_width(&word[..=cut], font, size) <= width {
                    cut += 1;
                }
                lines.push(word.drain(..cut).collect());
            }
            line = word;
        }
        lines.push(line);
    }
    lines
}

fn escape(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 8);
    for &byte in bytes {
        if matches!(byte, b'(' | b')' | b'\\') {
            out.push(b'\\');
        }
        out.push(byte);
    }
    out
}

const PAGE_WIDTH: f32 = 595.28;
const PAGE_HEIGHT: f32 = 841.89;
const MARGIN: f32 = 56.0;
const BODY: f32 = 10.5;
const FOOTER: f32 = 32.0;

struct Layout {
    pages: Vec<Vec<u8>>,
    current: Vec<u8>,
    y: f32,
}

impl Layout {
    fn new() -> Self {
        Layout { pages: Vec::new(), current: Vec::new(), y: PAGE_HEIGHT - MARGIN }
    }

    fn content_width() -> f32 {
        PAGE_WIDTH - 2.0 * MARGIN
    }

    fn new_page(&mut self) {
        self.pages.push(std::mem::take(&mut self.current));
        self.y = PAGE_HEIGHT - MARGIN;
    }

    /// Réserve `height` points, en passant à la page suivante s’il n’y a plus la place.
    fn reserve(&mut self, height: f32) {
        if self.y - height < MARGIN + FOOTER && self.y < PAGE_HEIGHT - MARGIN {
            self.new_page();
        }
    }

    fn text(&mut self, x: f32, y: f32, bytes: &[u8], font: Font, size: f32) {
        let name = if font == Font::Bold { "F2" } else { "F1" };
        self.current.extend_from_slice(format!("BT /{name} {size:.2} Tf {x:.2} {y:.2} Td (").as_bytes());
        self.current.extend(escape(bytes));
        self.current.extend_from_slice(b") Tj ET\n");
    }

    fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32) {
        self.current.extend_from_slice(format!("{x1:.2} {y1:.2} m {x2:.2} {y2:.2} l S\n").as_bytes());
    }

    fn fill(&mut self, x: f32, y: f32, width: f32, height: f32) {
        self.current.extend_from_slice(format!("0.94 g {x:.2} {y:.2} {width:.2} {height:.2} re f 0 g\n").as_bytes());
    }

    fn lines(&mut self, x: f32, lines: &[Vec<u8>], font: Font, size: f32) {
        let leading = size * 1.4;
        for line in lines {
            self.reserve(leading);
            self.y -= leading;
            self.text(x, self.y + size * 0.3, line, font, size);
        }
    }

    fn block(&mut self, block: &Block) {
        let width = Self::content_width();
        match block {
            Block::Heading { text, level } => {
                let size = match level {
                    1 => 18.0,
                    2 => 14.5,
                    _ => 12.0,
                };
                let lines = wrap(text, Font::Bold, size, width);
                // Un titre ne reste pas seul en bas de page.
                self.reserve(size * 1.4 * (lines.len() as f32) + BODY * 3.0);
                self.y -= size * 0.6;
                self.lines(MARGIN, &lines, Font::Bold, size);
                self.y -= size * 0.3;
            }
            Block::Paragraph { text } => {
                let lines = wrap(text, Font::Regular, BODY, width);
                self.lines(MARGIN, &lines, Font::Regular, BODY);
                self.y -= BODY * 0.6;
            }
            Block::List { items, ordered } => {
                let leading = BODY * 1.4;
                for (index, item) in items.iter().enumerate() {
                    let marker = encode(&if *ordered { format!("{}.", index + 1) } else { "•".to_string() });
                    for (line_index, line) in wrap(item, Font::Regular, BODY, width - 18.0).iter().enumerate() {
                        self.reserve(leading);
                        self.y -= leading;
                        if line_index == 0 {
                            self.text(MARGIN + 4.0, self.y + BODY * 0.3, &marker, Font::Regular, BODY);
                        }
                        self.text(MARGIN + 18.0, self.y + BODY * 0.3, line, Font::Regular, BODY);
                    }
                }
                self.y -= BODY * 0.6;
            }
            Block::Table { columns, rows, widths } => self.table(columns, rows, widths),
            Block::PageBreak => self.new_page(),
        }
    }

    fn table(&mut self, columns: &[String], rows: &[Vec<Value>], widths: &[f32]) {
        let count = columns.len().max(rows.iter().map(Vec::len).max().unwrap_or(0)).max(1);
        let total = Self::content_width();
        let weights: Vec<f32> = (0..count).map(|index| widths.get(index).copied().filter(|w| *w > 0.0).unwrap_or(1.0)).collect();
        let sum: f32 = weights.iter().sum();
        let sizes: Vec<f32> = weights.iter().map(|weight| total * weight / sum).collect();
        let padding = 4.0;
        let size = BODY - 1.0;
        let leading = size * 1.35;
        let cell_text = |value: &Value| match value {
            Value::Null => String::new(),
            Value::String(text) => text.clone(),
            Value::Bool(flag) => if *flag { "Oui".into() } else { "Non".into() },
            other => other.to_string(),
        };
        let header: Vec<Value> = columns.iter().map(|column| Value::String(column.clone())).collect();
        let draw_row = |layout: &mut Layout, cells: &[Value], font: Font| {
            let wrapped: Vec<Vec<Vec<u8>>> = (0..count)
                .map(|index| wrap(&cell_text(cells.get(index).unwrap_or(&Value::Null)), font, size, sizes[index] - 2.0 * padding))
                .collect();
            let height = wrapped.iter().map(Vec::len).max().unwrap_or(1).max(1) as f32 * leading + 2.0 * padding;
            layout.reserve(height);
            let top = layout.y;
            if font == Font::Bold {
                layout.fill(MARGIN, top - height, total, height);
            }
            let mut x = MARGIN;
            for (index, lines) in wrapped.iter().enumerate() {
                for (line_index, line) in lines.iter().enumerate() {
                    let baseline = top - padding - leading * (line_index as f32 + 1.0) + size * 0.3;
                    layout.text(x + padding, baseline, line, font, size);
                }
                x += sizes[index];
            }
            layout.line(MARGIN, top - height, MARGIN + total, top - height);
            layout.y = top - height;
        };
        if !columns.is_empty() {
            self.current.extend_from_slice(b"0.6 G 0.5 w\n");
            draw_row(self, &header, Font::Bold);
        }
        for row in rows {
            // Sur une nouvelle page, l’en-tête du tableau est répété.
            let mut probe = Layout { pages: Vec::new(), current: Vec::new(), y: self.y };
            draw_row(&mut probe, row, Font::Regular);
            if !probe.pages.is_empty() && !columns.is_empty() {
                self.new_page();
                draw_row(self, &header, Font::Bold);
            }
            draw_row(self, row, Font::Regular);
        }
        self.current.extend_from_slice(b"0 G 1 w\n");
        self.y -= BODY;
    }

    fn finish(mut self) -> Vec<Vec<u8>> {
        if !self.current.is_empty() || self.pages.is_empty() {
            self.pages.push(std::mem::take(&mut self.current));
        }
        self.pages
    }
}

/// Texte d’une chaîne PDF (métadonnées) en UTF-16 avec BOM, pour garder les accents.
fn pdf_string(text: &str) -> String {
    let mut out = String::from("<FEFF");
    for unit in text.encode_utf16() {
        out.push_str(&format!("{unit:04X}"));
    }
    out.push('>');
    out
}

/// Écrit un PDF A4 à partir de blocs.
pub fn render_pdf(title: Option<&str>, blocks: &[Block]) -> Vec<u8> {
    let mut layout = Layout::new();
    if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
        layout.block(&Block::Heading { text: title.to_string(), level: 1 });
    }
    for block in blocks {
        layout.block(block);
    }
    let pages = layout.finish();
    let total = pages.len();

    let mut objects: Vec<Vec<u8>> = Vec::new();
    // 1 catalogue, 2 arbre des pages, 3 et 4 polices, 5 informations ; puis contenu et page, deux à deux.
    let page_ids: Vec<usize> = (0..total).map(|index| 8 + index * 2).collect();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(
        format!(
            "<< /Type /Pages /Kids [{}] /Count {total} >>",
            page_ids.iter().map(|id| format!("{id} 0 R")).collect::<Vec<_>>().join(" ")
        )
        .into_bytes(),
    );
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_vec());
    let created = chrono::Local::now().format("D:%Y%m%d%H%M%S").to_string();
    objects.push(
        format!(
            "<< /Producer (Alfred) /CreationDate ({created}){} >>",
            title.map(|title| format!(" /Title {}", pdf_string(title))).unwrap_or_default()
        )
        .into_bytes(),
    );
    objects.push(b"<< /Font << /F1 3 0 R /F2 4 0 R >> >>".to_vec());
    for (index, mut content) in pages.into_iter().enumerate() {
        if total > 1 {
            let footer = encode(&format!("{} / {total}", index + 1));
            let x = PAGE_WIDTH - MARGIN - text_width(&footer, Font::Regular, 8.5);
            let mut layout = Layout { pages: Vec::new(), current: Vec::new(), y: 0.0 };
            layout.text(x, MARGIN * 0.6, &footer, Font::Regular, 8.5);
            content.extend(layout.current);
        }
        let mut stream = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
        stream.extend(content);
        stream.extend_from_slice(b"\nendstream");
        objects.push(stream);
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] /Resources 6 0 R /Contents {} 0 R >>",
                7 + index * 2
            )
            .into_bytes(),
        );
    }

    let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n", index + 1).into_bytes());
        out.extend(object);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).into_bytes());
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").into_bytes());
    }
    out.extend(
        format!("trailer\n<< /Size {} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).into_bytes(),
    );
    out
}

// ---------------------------------------------------------------------------------------------------------------
// CSV et Excel
// ---------------------------------------------------------------------------------------------------------------

fn cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// CSV en UTF-8 avec BOM et `;` par défaut : ce qu’Excel en français ouvre tel quel, accents compris.
pub fn render_csv(columns: &[String], rows: &[Vec<Value>], separator: char) -> Vec<u8> {
    let quote = |text: &str| {
        if text.contains([separator, '"', '\n', '\r']) || text.starts_with(' ') || text.ends_with(' ') {
            format!("\"{}\"", text.replace('"', "\"\""))
        } else {
            text.to_string()
        }
    };
    let sep = separator.to_string();
    let mut out = String::from("\u{feff}");
    if !columns.is_empty() {
        out.push_str(&columns.iter().map(|column| quote(column)).collect::<Vec<_>>().join(&sep));
        out.push_str("\r\n");
    }
    for row in rows {
        out.push_str(&row.iter().map(|value| quote(&cell(value))).collect::<Vec<_>>().join(&sep));
        out.push_str("\r\n");
    }
    out.into_bytes()
}

#[derive(Debug, Deserialize)]
pub struct Sheet {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
}

fn xlsx_error(error: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::new(format!("Classeur Excel impossible à écrire : {error}"))
}

/// Classeur Excel : une feuille par entrée, en-têtes en gras et figés, nombres et booléens gardés comme tels.
pub fn render_xlsx(sheets: &[Sheet]) -> AppResult<Vec<u8>> {
    use rust_xlsxwriter::{Format, Workbook};
    if sheets.is_empty() {
        return Err(AppError::new("Un classeur a au moins une feuille."));
    }
    let mut workbook = Workbook::new();
    let bold = Format::new().set_bold();
    for (index, sheet) in sheets.iter().enumerate() {
        let worksheet = workbook.add_worksheet();
        let name = sheet.name.clone().unwrap_or_else(|| format!("Feuille {}", index + 1));
        // Excel refuse ces caractères et plus de 31 caractères dans un nom de feuille.
        let name: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
        worksheet.set_name(if name.trim().is_empty() { format!("Feuille {}", index + 1) } else { name }).map_err(xlsx_error)?;
        let mut first = 0;
        if !sheet.columns.is_empty() {
            for (column, title) in sheet.columns.iter().enumerate() {
                worksheet.write_string_with_format(0, column as u16, title, &bold).map_err(xlsx_error)?;
            }
            worksheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
            first = 1;
        }
        for (row_index, row) in sheet.rows.iter().enumerate() {
            let row_number = (row_index + first) as u32;
            for (column, value) in row.iter().enumerate() {
                let column = column as u16;
                match value {
                    Value::Null => {}
                    Value::Bool(flag) => {
                        worksheet.write_boolean(row_number, column, *flag).map_err(xlsx_error)?;
                    }
                    Value::Number(number) => {
                        worksheet.write_number(row_number, column, number.as_f64().unwrap_or_default()).map_err(xlsx_error)?;
                    }
                    other => {
                        worksheet.write_string(row_number, column, cell(other)).map_err(xlsx_error)?;
                    }
                }
            }
        }
        worksheet.autofit();
    }
    workbook.save_to_buffer().map_err(xlsx_error)
}

// ---------------------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------------------

/// Décode les entités XML d’un texte (`&amp;`, `&#233;`…).
fn xml_unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find(';').filter(|end| *end <= 12) else {
            out.push('&');
            rest = &after[1..];
            continue;
        };
        let entity = &after[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32),
            _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Texte d’un document Word (.docx) : paragraphes séparés par des retours à la ligne, tabulations gardées.
pub fn docx_text(bytes: &[u8]) -> AppResult<String> {
    let unreadable = || AppError::new("Ce document Word est illisible (.docx attendu, pas .doc).");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| unreadable())?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| unreadable())?
        .take(64 * 1024 * 1024)
        .read_to_string(&mut xml)
        .map_err(|_| unreadable())?;
    let mut text = String::new();
    let mut in_text = false;
    let mut rest = xml.as_str();
    while let Some(open) = rest.find('<') {
        if in_text {
            text.push_str(&xml_unescape(&rest[..open]));
        }
        let Some(close) = rest[open..].find('>') else { break };
        let tag = &rest[open + 1..open + close];
        rest = &rest[open + close + 1..];
        let closing = tag.starts_with('/');
        let empty = tag.ends_with('/');
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or_default();
        match (name, closing, empty) {
            ("w:t", false, false) => in_text = true,
            ("w:t", true, _) => in_text = false,
            ("w:p", true, _) => text.push('\n'),
            ("w:tab", false, true) => text.push('\t'),
            ("w:br" | "w:cr", false, true) => text.push('\n'),
            _ => {}
        }
    }
    Ok(text.trim_end().to_string())
}

/// Texte d’un PDF, page par page. Un PDF scanné (des images, sans texte) rend des pages vides.
pub fn pdf_pages(bytes: &[u8]) -> AppResult<Vec<String>> {
    // La bibliothèque peut paniquer sur un PDF mal formé : l’erreur reste une erreur pour la page.
    let bytes = bytes.to_vec();
    std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem_by_pages(&bytes))
        .map_err(|_| AppError::new("Ce PDF n’a pas pu être lu."))?
        .map_err(|error| AppError::new(format!("Ce PDF n’a pas pu être lu : {error}")))
}

pub fn extract_text(info: &FileInfo, bytes: &[u8]) -> AppResult<Value> {
    let lower = info.name.to_ascii_lowercase();
    let (text, pages) = if info.mime == "application/pdf" || lower.ends_with(".pdf") || bytes.starts_with(b"%PDF") {
        let pages = pdf_pages(bytes)?;
        let count = pages.len();
        (pages.join("\n\u{c}"), Some(count))
    } else if lower.ends_with(".docx") || info.mime.contains("wordprocessingml") {
        (docx_text(bytes)?, None)
    } else if info.mime.starts_with("text/") || matches!(info.mime.as_str(), "application/json" | "application/xml") {
        (String::from_utf8_lossy(bytes).to_string(), None)
    } else {
        return Err(AppError::new(format!(
            "Le texte d’un fichier « {} » ne se lit pas : PDF, Word (.docx) ou texte attendu.",
            info.mime
        )));
    };
    let truncated = text.len() > MAX_TEXT;
    let text = if truncated {
        let mut end = MAX_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    } else {
        text
    };
    Ok(json!({ "text": text, "pages": pages, "truncated": truncated }))
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

fn with_extension(name: &str, extension: &str) -> String {
    let name = name.trim();
    if name.to_ascii_lowercase().ends_with(&format!(".{extension}")) {
        name.to_string()
    } else {
        format!("{name}.{extension}")
    }
}

fn produce(space: &Space, module: &str, command: &str, args: &Value) -> AppResult<Value> {
    let name: String = arg(args, "name")?;
    let (file_name, mime, bytes) = match command {
        "frame.documents.pdf" => {
            let title: Option<String> = opt_arg(args, "title")?;
            let blocks: Vec<Block> = opt_arg(args, "blocks")
                .map_err(|error| AppError::new(format!("Blocs invalides : {}", error.message)))?
                .unwrap_or_default();
            (with_extension(&name, "pdf"), "application/pdf", render_pdf(title.as_deref(), &blocks))
        }
        "frame.documents.csv" => {
            let columns: Vec<String> = opt_arg(args, "columns")?.unwrap_or_default();
            let rows: Vec<Vec<Value>> = opt_arg(args, "rows")?.unwrap_or_default();
            let separator: Option<String> = opt_arg(args, "separator")?;
            let separator = match separator.as_deref() {
                None => ';',
                Some(text) if text.chars().count() == 1 => text.chars().next().unwrap_or(';'),
                Some(_) => return Err(AppError::new("`separator` est un seul caractère : « ; », « , » ou une tabulation.")),
            };
            (with_extension(&name, "csv"), "text/csv", render_csv(&columns, &rows, separator))
        }
        _ => {
            let sheets: Vec<Sheet> = arg(args, "sheets")?;
            (
                with_extension(&name, "xlsx"),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                render_xlsx(&sheets)?,
            )
        }
    };
    Ok(json!(module_files::save(space, module, &file_name, Some(mime), &bytes)?))
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("frame.documents.") {
        return None;
    }
    let state = state.clone();
    let command = command.to_string();
    let args = args.clone();
    // Un gros PDF à lire ou à écrire ne bloque pas les autres commandes.
    let result = tokio::task::spawn_blocking(move || -> AppResult<Value> {
        let subject: Subject = arg(&args, "subject")?;
        let space = state.space()?;
        match command.as_str() {
            "frame.documents.pdf" | "frame.documents.csv" | "frame.documents.xlsx" => {
                produce(&space, &subject.module, &command, &args)
            }
            "frame.documents.extractText" => {
                let (info, bytes) = module_files::read(&space, &subject.module, &arg::<String>(&args, "id")?)?;
                extract_text(&info, &bytes)
            }
            _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
        }
    })
    .await
    .unwrap_or_else(|_| Err(AppError::new("Le document n’a pas pu être traité.")));
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocks(value: Value) -> Vec<Block> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_pdf_is_written_and_read_back_with_its_accents() {
        let rows: Vec<Value> = (1..=80).map(|n| json!([format!("Ligne {n}"), n, n % 2 == 0])).collect();
        let pdf = render_pdf(
            Some("Rapport d’activité"),
            &blocks(json!([
                { "type": "heading", "text": "Résumé", "level": 2 },
                { "type": "paragraph", "text": "Été 2026 : l’équipe a traité « 42 » demandes, coût 1 250 €. ".repeat(12) },
                { "type": "list", "items": ["Première", "Deuxième"], "ordered": true },
                { "type": "table", "columns": ["Libellé", "Nombre", "Pair"], "rows": rows, "widths": [3, 1, 1] },
                { "type": "pageBreak" },
                { "type": "paragraph", "text": "Fin." }
            ])),
        );
        assert!(pdf.starts_with(b"%PDF-1.4"));
        let pages = pdf_pages(&pdf).unwrap();
        assert!(pages.len() >= 3, "{} pages", pages.len());
        let text = pages.join("\n");
        for expected in ["Rapport d’activité", "Résumé", "Été 2026", "« 42 »", "1 250 €", "Ligne 80", "Fin."] {
            assert!(text.contains(expected), "« {expected} » absent de :\n{text}");
        }
        // L’en-tête du tableau est répété sur la page suivante.
        assert!(pages.iter().filter(|page| page.contains("Libellé")).count() >= 2);
    }

    #[test]
    fn a_long_word_is_cut_to_fit_the_line() {
        let lines = wrap(&"a".repeat(400), Font::Regular, 10.0, 100.0);
        assert!(lines.len() > 1);
        assert!(lines.iter().all(|line| text_width(line, Font::Regular, 10.0) <= 100.0));
    }

    #[test]
    fn csv_opens_in_french_excel() {
        let csv = render_csv(
            &["Nom".into(), "Note".into()],
            &[vec![json!("Dupont; Jean"), json!(12.5)], vec![json!("Dit \"Jo\""), Value::Null]],
            ';',
        );
        let text = String::from_utf8(csv).unwrap();
        assert_eq!(text, "\u{feff}Nom;Note\r\n\"Dupont; Jean\";12.5\r\n\"Dit \"\"Jo\"\"\";\r\n");
    }

    #[test]
    fn an_excel_workbook_has_one_sheet_per_entry() {
        let sheets: Vec<Sheet> = serde_json::from_value(json!([
            { "name": "Ventes/2026", "columns": ["Mois", "Total"], "rows": [["Janvier", 1200], ["Février", 980.5]] },
            { "rows": [[true, null, "x"]] }
        ]))
        .unwrap();
        let bytes = render_xlsx(&sheets).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut workbook = String::new();
        archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut workbook).unwrap();
        assert!(workbook.contains("Ventes2026") && workbook.contains("Feuille 2"), "{workbook}");
        let mut strings = String::new();
        archive.by_name("xl/sharedStrings.xml").unwrap().read_to_string(&mut strings).unwrap();
        assert!(strings.contains("Février"));
    }

    #[test]
    fn word_text_keeps_paragraphs_and_accents() {
        use std::io::Write;
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(
                br#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
                <w:p><w:r><w:t>Objet : r&#233;union</w:t></w:r></w:p>
                <w:p><w:r><w:t xml:space="preserve">Nom </w:t><w:tab/><w:t>Valeur &amp; co</w:t></w:r></w:p>
                </w:body></w:document>"#,
            )
            .unwrap();
            zip.finish().unwrap();
        }
        let text = docx_text(buffer.get_ref()).unwrap();
        assert_eq!(text, "Objet : réunion\nNom \tValeur & co");
        assert!(docx_text(b"pas un zip").is_err());
    }

    #[test]
    fn documents_become_files_of_the_module() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let args = json!({ "name": "Liste", "columns": ["a"], "rows": [[1]] });
        let saved: FileInfo = serde_json::from_value(produce(&space, "notes", "frame.documents.csv", &args).unwrap()).unwrap();
        assert_eq!((saved.name.as_str(), saved.mime.as_str()), ("Liste.csv", "text/csv"));
        let pdf = produce(&space, "notes", "frame.documents.pdf", &json!({ "name": "r.pdf", "blocks": [{ "type": "paragraph", "text": "Bonjour" }] })).unwrap();
        let (info, bytes) = module_files::read(&space, "notes", pdf["id"].as_str().unwrap()).unwrap();
        assert_eq!(info.name, "r.pdf");
        assert!(extract_text(&info, &bytes).unwrap()["text"].as_str().unwrap().contains("Bonjour"));
        let image = module_files::save(&space, "notes", "x.png", None, b"png").unwrap();
        assert!(extract_text(&image, b"png").is_err());
    }
}
