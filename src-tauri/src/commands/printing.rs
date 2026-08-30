// Printing (spec §5.21). md-easy lays its own sheets out in the WebView — page
// boxes with margins, running header/footer and pagination already applied — and
// then prints that page through WebView2's own print API instead of
// `window.print()`. That is what keeps the browser's print dialog, and the
// URL/date banner it stamps on every sheet, out of the output: the print
// workspace in the frontend is the only dialog the user sees.
//
// Both print commands start the job and return; completion (or failure) is
// reported to the frontend as the `print-completed` event, so the frontend can
// restore its DOM and close the workspace at the right moment.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, WebviewWindow};

/// One installed printer offered in the print workspace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// Page setup for a print run. Margins are always zero and scaling is always 1:
/// the rendered page boxes already are the finished sheets.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct NativePrintOptions {
    /// Empty selects the system default printer.
    pub printer_name: String,
    pub copies: u32,
    /// "portrait" | "landscape".
    pub orientation: String,
    pub page_width_in: f64,
    pub page_height_in: f64,
    /// "1-3,5" style range; empty prints every page.
    pub page_ranges: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintCompleted {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

const PRINT_COMPLETED: &str = "print-completed";

fn emit_completed(window: &WebviewWindow, ok: bool, message: Option<String>) {
    let _ = window.emit(PRINT_COMPLETED, PrintCompleted { ok, message });
}

/// Installed printers, the default one first (spec §5.21).
///
/// Read from the registry rather than the print spooler API: the printers a user
/// can print to are exactly the values under `…\CurrentVersion\Devices`, and the
/// default is named by `…\CurrentVersion\Windows\Device`. That keeps this to the
/// `winreg` dependency the app already carries for the default-.md-handler check
/// (§5.12), and returns instantly — no spooler round-trip on opening the dialog.
#[tauri::command]
pub fn list_printers() -> Vec<PrinterInfo> {
    #[cfg(windows)]
    {
        windows_impl::list_printers()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Print the current WebView contents (spec §5.21).
#[tauri::command]
pub async fn print_webview(
    window: WebviewWindow,
    options: NativePrintOptions,
) -> Result<(), AppError> {
    start_print(window, options, None)
}

/// Write the current WebView contents to a PDF at `path` (spec §5.21).
#[tauri::command]
pub async fn print_webview_to_pdf(
    window: WebviewWindow,
    path: String,
    options: NativePrintOptions,
) -> Result<(), AppError> {
    start_print(window, options, Some(path))
}

/// Queue a print (or print-to-PDF, when `pdf_path` is set) on the WebView thread.
fn start_print(
    window: WebviewWindow,
    options: NativePrintOptions,
    pdf_path: Option<String>,
) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        windows_impl::start_print(window, options, pdf_path)
    }
    #[cfg(not(windows))]
    {
        let _ = (options, pdf_path);
        emit_completed(
            &window,
            false,
            Some("Printing is only available on Windows.".into()),
        );
        Ok(())
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::{emit_completed, NativePrintOptions, PrinterInfo};
    use crate::error::AppError;
    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2PrintSettings2,
        ICoreWebView2_16, ICoreWebView2_2, ICoreWebView2_7,
        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
        COREWEBVIEW2_PRINT_STATUS, COREWEBVIEW2_PRINT_STATUS_OTHER_ERROR,
        COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE, COREWEBVIEW2_PRINT_STATUS_SUCCEEDED,
    };
    use webview2_com::{PrintCompletedHandler, PrintToPdfCompletedHandler};
    use windows_core::{Interface, HSTRING};
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const DEVICES_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Devices";
    const WINDOWS_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Windows";

    pub fn list_printers() -> Vec<PrinterInfo> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // "PrinterName,winspool,Ne00:" — the printer is the part before the comma.
        let default_name = hkcu
            .open_subkey(WINDOWS_KEY)
            .ok()
            .and_then(|k| k.get_value::<String, _>("Device").ok())
            .map(|v| v.split(',').next().unwrap_or_default().to_string())
            .unwrap_or_default();

        let mut printers: Vec<PrinterInfo> = hkcu
            .open_subkey(DEVICES_KEY)
            .map(|k| {
                k.enum_values()
                    .filter_map(|v| v.ok())
                    .map(|(name, _)| PrinterInfo {
                        is_default: name == default_name,
                        name,
                    })
                    .collect()
            })
            .unwrap_or_default();

        // A default that isn't listed under Devices (rare, but possible for a
        // freshly connected network printer) still has to be offerable.
        if !default_name.is_empty() && !printers.iter().any(|p| p.is_default) {
            printers.push(PrinterInfo {
                name: default_name,
                is_default: true,
            });
        }
        printers.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.cmp(&b.name)));
        printers
    }

    pub fn start_print(
        window: WebviewWindow,
        options: NativePrintOptions,
        pdf_path: Option<String>,
    ) -> Result<(), AppError> {
        let reporter = window.clone();
        window
            .with_webview(move |platform| {
                if let Err(message) = run(&platform, &options, pdf_path.as_deref(), &reporter) {
                    emit_completed(&reporter, false, Some(message));
                }
            })
            .map_err(|e| AppError::new("print", e.to_string()))
    }

    /// Configure the print settings and hand the job to WebView2. The completion
    /// handler emits `print-completed`; only a failure to *start* returns Err.
    fn run(
        platform: &tauri::webview::PlatformWebview,
        options: &NativePrintOptions,
        pdf_path: Option<&str>,
        reporter: &WebviewWindow,
    ) -> Result<(), String> {
        unsafe {
            let core = platform.controller().CoreWebView2().map_err(err)?;
            let environment = core
                .cast::<ICoreWebView2_2>()
                .map_err(err)?
                .Environment()
                .map_err(err)?
                .cast::<ICoreWebView2Environment6>()
                .map_err(err)?;
            let settings = environment.CreatePrintSettings().map_err(err)?;
            apply(&settings, options)?;

            match pdf_path {
                Some(path) => {
                    let target = HSTRING::from(path);
                    let window = reporter.clone();
                    // The handler's second argument is already a plain `bool`:
                    // webview2-com converts the COM `BOOL` for us (callback.rs).
                    let handler = PrintToPdfCompletedHandler::create(Box::new(
                        move |result, wrote| {
                            let ok = result.is_ok() && wrote;
                            let message = (!ok).then(|| "The PDF could not be written.".to_string());
                            emit_completed(&window, ok, message);
                            Ok(())
                        },
                    ));
                    core.cast::<ICoreWebView2_7>()
                        .map_err(err)?
                        .PrintToPdf(&target, &settings, &handler)
                        .map_err(err)?;
                }
                None => {
                    let window = reporter.clone();
                    let handler =
                        PrintCompletedHandler::create(Box::new(move |result, status| {
                            let ok = result.is_ok() && status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED;
                            emit_completed(&window, ok, status_message(status));
                            Ok(())
                        }));
                    core.cast::<ICoreWebView2_16>()
                        .map_err(err)?
                        .Print(&settings, &handler)
                        .map_err(err)?;
                }
            }
        }
        Ok(())
    }

    /// Zero margins, scale 1 and no browser header/footer: the page already *is*
    /// the sheet, so anything the printer added would be a second layer on top.
    unsafe fn apply(
        settings: &ICoreWebView2PrintSettings,
        options: &NativePrintOptions,
    ) -> Result<(), String> {
        settings
            .SetOrientation(if options.orientation == "landscape" {
                COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
            } else {
                COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
            })
            .map_err(err)?;
        settings.SetScaleFactor(1.0).map_err(err)?;
        settings.SetPageWidth(options.page_width_in).map_err(err)?;
        settings.SetPageHeight(options.page_height_in).map_err(err)?;
        settings.SetMarginTop(0.0).map_err(err)?;
        settings.SetMarginBottom(0.0).map_err(err)?;
        settings.SetMarginLeft(0.0).map_err(err)?;
        settings.SetMarginRight(0.0).map_err(err)?;
        // Backgrounds on: table rules, code-block fills and the running-header
        // rule are part of the document's appearance, not decoration.
        settings.SetShouldPrintBackgrounds(true).map_err(err)?;
        settings.SetShouldPrintSelectionOnly(false).map_err(err)?;
        settings.SetShouldPrintHeaderAndFooter(false).map_err(err)?;

        // Printer name, copies and page ranges live on the v2 settings interface.
        // An older WebView2 runtime without it still prints, just to the default
        // printer with one copy — better than refusing the job.
        if let Ok(settings2) = settings.cast::<ICoreWebView2PrintSettings2>() {
            let _ = settings2.SetCopies(options.copies.clamp(1, 999) as i32);
            if !options.printer_name.is_empty() {
                let _ = settings2.SetPrinterName(&HSTRING::from(options.printer_name.as_str()));
            }
            if !options.page_ranges.is_empty() {
                let _ = settings2.SetPageRanges(&HSTRING::from(options.page_ranges.as_str()));
            }
        }
        Ok(())
    }

    /// `None` when the job succeeded — the frontend shows nothing in that case.
    fn status_message(status: COREWEBVIEW2_PRINT_STATUS) -> Option<String> {
        if status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED {
            None
        } else if status == COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE {
            Some("That printer is unavailable.".into())
        } else if status == COREWEBVIEW2_PRINT_STATUS_OTHER_ERROR {
            Some("The printer rejected the job.".into())
        } else {
            Some("Printing did not complete.".into())
        }
    }

    fn err(e: windows_core::Error) -> String {
        e.message().to_string()
    }
}
