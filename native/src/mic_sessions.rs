//! Lists the processes that are actively recording from a microphone, so the
//! app can show which meeting app (Zoom, Teams, a browser…) is on a call.

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct MicSession {
    pub pid: u32,
    /// Executable file name, e.g. "Zoom.exe". Empty if the process can't be opened.
    pub exe: String,
}

#[napi]
pub fn list_mic_sessions() -> Result<Vec<MicSession>> {
    // COM is initialized per thread, and the Node main thread may already be in
    // a different apartment mode, so query from a short-lived MTA thread.
    std::thread::spawn(imp::list)
        .join()
        .map_err(|_| Error::from_reason("microphone session query panicked"))?
        .map_err(|e| Error::from_reason(format!("microphone session query failed: {e}")))
}

#[cfg(windows)]
mod imp {
    use super::MicSession;
    use std::collections::HashSet;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Media::Audio::{
        AudioSessionStateActive, DEVICE_STATE_ACTIVE, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::core::{Interface, PWSTR, Result};

    pub fn list() -> Result<Vec<MicSession>> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let result = sessions();
            CoUninitialize();
            result
        }
    }

    unsafe fn sessions() -> Result<Vec<MicSession>> {
        let mut seen = HashSet::new();
        let mut found = Vec::new();
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
            for i in 0..devices.GetCount()? {
                let device = devices.Item(i)?;
                let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
                let list = manager.GetSessionEnumerator()?;
                for j in 0..list.GetCount()? {
                    let control = list.GetSession(j)?;
                    if control.GetState()? != AudioSessionStateActive {
                        continue;
                    }
                    let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                        continue;
                    };
                    let Ok(pid) = control2.GetProcessId() else {
                        continue;
                    };
                    // pid 0 is the system sounds session.
                    if pid != 0 && seen.insert(pid) {
                        found.push(MicSession { pid, exe: exe_name(pid) });
                    }
                }
            }
        }
        Ok(found)
    }

    fn exe_name(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let name = query_image_name(handle);
            let _ = CloseHandle(handle);
            name
        }
    }

    unsafe fn query_image_name(handle: HANDLE) -> String {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
        };
        if ok.is_err() {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().unwrap_or_default().to_string()
    }
}

#[cfg(not(windows))]
mod imp {
    use super::MicSession;

    pub fn list() -> std::result::Result<Vec<MicSession>, String> {
        Ok(Vec::new())
    }
}
