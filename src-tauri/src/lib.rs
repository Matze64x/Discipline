use tauri::{Manager, WebviewWindowBuilder};

pub mod data_dir;
pub mod files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // a second instance would keep its own copy of the data; focus the running one instead
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            files::read_file,
            files::write_file,
            files::file_exists,
            files::data_location,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            let data_dir = data_dir::resolve(app.path().app_data_dir().ok());
            let webview_dir = data_dir.as_ref().and_then(data_dir::DataDir::webview);
            // (before the window exists, so its first commands find it)
            if let Some(dir) = data_dir {
                app.manage(dir);
            }
            // the window is created here (`create: false` in tauri.conf.json): the portable version
            // needs its webview storage in the portable folder
            let mut window = WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?;
            if let Some(dir) = webview_dir {
                window = window.data_directory(dir);
            }
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Discipline desktop app");
}
