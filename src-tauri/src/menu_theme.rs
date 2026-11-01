// Tauri/muda themes the Windows menu bar, but popup menus use the process UX
// theme. Windows exposes this only via optional uxtheme ordinals, as also used
// by https://github.com/microsoft/PowerToys/blob/main/src/modules/ZoomIt/ZoomIt/Utility.cpp
// Gate their version and presence;
// older systems keep the native appearance without changing global settings.
#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, sync::OnceLock};
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *const c_void;
    }
    type SetMode = unsafe extern "system" fn(i32) -> i32;
    type Flush = unsafe extern "system" fn();
    type Version = unsafe extern "system" fn(*mut u32, *mut u32, *mut u32);
    static API: OnceLock<Option<(SetMode, Flush)>> = OnceLock::new();

    fn load() -> Option<(SetMode, Flush)> {
        unsafe {
            let ntdll: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
            let module = GetModuleHandleW(ntdll.as_ptr());
            if module.is_null() {
                return None;
            }
            let version = GetProcAddress(module, c"RtlGetNtVersionNumbers".as_ptr().cast());
            if version.is_null() {
                return None;
            }
            let (mut major, mut minor, mut build) = (0, 0, 0);
            std::mem::transmute::<*const c_void, Version>(version)(
                &mut major, &mut minor, &mut build,
            );
            if major < 10 || build & 0x0fff_ffff < 18362 {
                return None;
            }
            let name: Vec<u16> = "uxtheme.dll\0".encode_utf16().collect();
            // Load from System32 only; retain for the lifetime of cached pointers.
            let library = LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), 0x800);
            if library.is_null() {
                return None;
            }
            let mode = GetProcAddress(library, 135usize as *const u8);
            let flush = GetProcAddress(library, 136usize as *const u8);
            if mode.is_null() || flush.is_null() {
                return None;
            }
            Some((
                std::mem::transmute::<*const c_void, SetMode>(mode),
                std::mem::transmute::<*const c_void, Flush>(flush),
            ))
        }
    }
    pub fn apply(dark: bool) {
        if let Some((set, flush)) = API.get_or_init(load) {
            unsafe {
                set(if dark { 2 } else { 3 });
                flush();
            }
        }
    }

    #[test]
    fn optional_popup_theme_api_switches_and_restores_process_preference() {
        let Some((set, flush)) = API.get_or_init(load) else {
            println!("Popup theme API unavailable; native fallback retained");
            return;
        };
        // This affects only the test executable, never the user's running app.
        unsafe {
            let previous = set(2);
            flush();
            set(3);
            flush();
            set(previous);
            flush();
        }
        println!("Windows popup theme API loaded; both palettes applied and restored");
    }
}

#[tauri::command]
pub fn sync_menu_theme(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(windows)]
    window
        .run_on_main_thread(move || windows::apply(dark))
        .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let _ = (window, dark);
    Ok(())
}
