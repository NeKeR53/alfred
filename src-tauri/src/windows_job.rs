//! Sous Windows, l’arbre d’un CLI d’agent est enfermé dans un Job Object dès sa création : le processus est lancé
//! suspendu, rattaché au Job, puis relancé. Aucun descendant ne peut donc y échapper, et la fermeture du Job, même
//! par la mort brutale d’Alfred, les arrête tous (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`). Repris de OneApp.
use std::mem::{size_of, zeroed};
use std::os::windows::{io::AsRawHandle, process::CommandExt};
use std::process::{Child, Command};
use std::ptr;

use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
    },
};

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: This wrapper exclusively owns a valid handle returned by a Win32 API.
        unsafe { CloseHandle(self.0) };
    }
}

/// Job Object qui contient l’arbre d’un agent ; le fermer arrête tout ce qui y vit encore.
pub(crate) struct Job(Handle);

// SAFETY: A job handle is a kernel object reference, usable from any thread; it is only closed by Drop.
unsafe impl Send for Job {}
// SAFETY: TerminateJobObject may be called concurrently on the same handle.
unsafe impl Sync for Job {}

impl Job {
    pub(crate) fn terminate(&self) -> bool {
        // SAFETY: The job contains only the child spawned suspended by `spawn` and its descendants.
        unsafe { TerminateJobObject(self.0 .0, 1) != 0 }
    }
}

fn io_error(message: &str) -> std::io::Error {
    std::io::Error::other(message.to_string())
}

pub(crate) fn spawn(command: &mut Command) -> std::io::Result<(Child, Job)> {
    // SAFETY: Null security attributes and name request a private, unnamed job.
    let raw_job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if raw_job.is_null() {
        return Err(io_error("impossible de préparer le suivi du processus"));
    }
    let job = Job(Handle(raw_job));
    // SAFETY: The Win32 structure is plain numeric fields; zero is valid here.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` has the exact structure and size required by this information class.
    let configured = unsafe {
        SetInformationJobObject(
            job.0 .0,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(io_error("impossible de configurer le suivi du processus"));
    }
    // `creation_flags` remplace les drapeaux précédents : CREATE_NO_WINDOW doit être répété.
    command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    let mut child = command.spawn()?;
    // SAFETY: `child` owns the live process handle and `job` owns a valid job handle.
    if unsafe { AssignProcessToJobObject(job.0 .0, child.as_raw_handle() as HANDLE) } == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io_error("impossible d’isoler le processus"));
    }
    if resume_threads(child.id()).is_err() {
        job.terminate();
        let _ = child.wait();
        return Err(io_error("impossible de démarrer le processus isolé"));
    }
    Ok((child, job))
}

fn resume_threads(pid: u32) -> Result<(), ()> {
    // SAFETY: Read-only snapshot; only threads owned by the still-open child PID are resumed.
    let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw_snapshot == INVALID_HANDLE_VALUE {
        return Err(());
    }
    let snapshot = Handle(raw_snapshot);
    // SAFETY: THREADENTRY32 accepts zero-initialization with dwSize filled below.
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    // SAFETY: Snapshot and entry are valid for the enumeration calls.
    let mut available = unsafe { Thread32First(snapshot.0, &mut entry) };
    let mut resumed = false;
    while available != 0 {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: The snapshot selected a thread belonging to the owned child PID.
            let raw_thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if raw_thread.is_null() {
                return Err(());
            }
            let thread = Handle(raw_thread);
            // SAFETY: The handle grants THREAD_SUSPEND_RESUME on a thread of the owned child.
            let previous = unsafe { ResumeThread(thread.0) };
            if previous == u32::MAX {
                return Err(());
            }
            resumed |= previous > 0;
        }
        // SAFETY: Same valid snapshot and entry used by Thread32First.
        available = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    if resumed {
        Ok(())
    } else {
        Err(())
    }
}
