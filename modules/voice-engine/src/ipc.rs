// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Canalización Reactiva de IPC mediante Named Pipes (Windows) y sockets reactivos (Unix).
//! Elimina el polling continuo a disco con sleep(15ms), reemplazándolo por I/O reactivo
//! impulsado por eventos e interrupciones del kernel (cero latencia de espera, cero I/O a disco).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\zen_voice_ipc";

#[cfg(unix)]
pub const DEFAULT_SOCKET_PATH: &str = "/tmp/zen_voice_ipc.sock";

/// Normaliza el nombre del Named Pipe en Windows asegurando el prefijo `\\.\pipe\`.
pub fn normalize_pipe_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.starts_with(r"\\.\pipe\") || trimmed.starts_with("//./pipe/") {
        trimmed.to_string()
    } else {
        format!(r"\\.\pipe\{}", trimmed)
    }
}

/// Resuelve el nombre del Named Pipe en Windows:
/// 1. Argumento de línea de comando `--pipe <name>` o `--pipe=<name>`.
/// 2. Variable de entorno `ZEN_VOICE_PIPE_NAME`.
/// 3. Por defecto `\\.\pipe\zen_voice_ipc`.
pub fn resolve_pipe_name() -> String {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if (args[i] == "--pipe" || args[i] == "--pipe-name") && i + 1 < args.len() {
            return normalize_pipe_name(&args[i + 1]);
        }
        if let Some(val) = args[i].strip_prefix("--pipe=") {
            return normalize_pipe_name(val);
        }
    }

    if let Ok(name) = std::env::var("ZEN_VOICE_PIPE_NAME") {
        if !name.trim().is_empty() {
            return normalize_pipe_name(&name);
        }
    }

    DEFAULT_PIPE_NAME.to_string()
}

/// Resuelve la ruta del socket reactivo en Unix:
/// 1. Argumento de línea de comando `--socket <path>` o `--socket=<path>`.
/// 2. Variable de entorno `ZEN_VOICE_SOCKET_PATH`.
/// 3. Por defecto `/tmp/zen_voice_ipc.sock`.
#[cfg(unix)]
pub fn resolve_socket_path() -> PathBuf {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if (args[i] == "--socket" || args[i] == "--socket-path") && i + 1 < args.len() {
            return PathBuf::from(&args[i + 1]);
        }
        if let Some(val) = args[i].strip_prefix("--socket=") {
            return PathBuf::from(val);
        }
    }

    if let Ok(path) = std::env::var("ZEN_VOICE_SOCKET_PATH") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    PathBuf::from(DEFAULT_SOCKET_PATH)
}

/// Resuelve la ruta del archivo IPC de fallback para compatibilidad hacia atrás:
/// 1. Argumento de línea de comando `--ipc <path>` o `--ipc-path <path>`.
/// 2. Variable de entorno `ZEN_VOICE_IPC_PATH`.
/// Retorna `None` si no fue configurado explícitamente, evitando polling innecesario a disco.
pub fn resolve_ipc_file_path() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if (args[i] == "--ipc" || args[i] == "--ipc-path") && i + 1 < args.len() {
            return Some(PathBuf::from(&args[i + 1]));
        }
        if let Some(val) = args[i].strip_prefix("--ipc=") {
            return Some(PathBuf::from(val));
        }
    }

    if let Ok(path) = std::env::var("ZEN_VOICE_IPC_PATH") {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path));
        }
    }

    None
}

/// Emisión atómica y sincronizada del evento `"transcription_ready"` a stdout.
pub fn emit_transcription_ready(transcript: &str) {
    let json = serde_json::json!({
        "type": "transcription_ready",
        "transcript": transcript
    });
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", json);
    let _ = out.flush();
}

/// Servidor reactivo de Named Pipe para Windows basado en IOCP y Tokio.
#[cfg(windows)]
pub async fn run_named_pipe_server<F>(pipe_name: String, on_transcript: F) -> std::io::Result<()>
where
    F: Fn(&str) + Send + Sync + 'static,
{
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::windows::named_pipe::ServerOptions;

    let on_transcript = Arc::new(on_transcript);

    let mut server = match ServerOptions::new().first_pipe_instance(true).create(&pipe_name) {
        Ok(s) => s,
        Err(_) => ServerOptions::new().create(&pipe_name)?,
    };

    loop {
        if let Err(e) = server.connect().await {
            // Error transitorio al conectar cliente
            tracing::debug!("Error conectando cliente Named Pipe: {}", e);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            server = match ServerOptions::new().create(&pipe_name) {
                Ok(s) => s,
                Err(_) => continue,
            };
            continue;
        }

        let connected_client = server;
        server = match ServerOptions::new().create(&pipe_name) {
            Ok(s) => s,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                ServerOptions::new().create(&pipe_name)?
            }
        };

        let on_tx = Arc::clone(&on_transcript);
        tokio::spawn(async move {
            let mut reader = BufReader::new(connected_client);
            let mut buf = Vec::new();

            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break, // EOF: cliente desconectado
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buf);
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            on_tx(trimmed);
                        }
                    }
                    Err(_) => break, // Desconexión o cierre del pipe
                }
            }
        });
    }
}

/// Servidor reactivo de Unix Domain Socket para plataformas Unix.
#[cfg(unix)]
pub async fn run_unix_socket_server<F>(socket_path: PathBuf, on_transcript: F) -> std::io::Result<()>
where
    F: Fn(&str) + Send + Sync + 'static,
{
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixListener;

    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    let on_transcript = Arc::new(on_transcript);

    loop {
        let (stream, _) = listener.accept().await?;
        let on_tx = Arc::clone(&on_transcript);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buf);
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            on_tx(trimmed);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
}

/// Hilo de fallback para compatibilidad hacia atrás cuando se especifica explícitamente `--ipc <archivo>`.
pub fn spawn_file_fallback_listener<F>(ipc_path: PathBuf, on_transcript: F)
where
    F: Fn(&str) + Send + Sync + 'static,
{
    let _ = std::fs::write(&ipc_path, "");

    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Seek, SeekFrom};
        let mut last_pos: u64 = std::fs::metadata(&ipc_path)
            .map(|m| m.len())
            .unwrap_or(0);

        loop {
            if let Ok(metadata) = std::fs::metadata(&ipc_path) {
                let len = metadata.len();
                if len > last_pos {
                    if let Ok(mut file) = std::fs::File::open(&ipc_path) {
                        if file.seek(SeekFrom::Start(last_pos)).is_ok() {
                            let reader = BufReader::new(file);
                            for l in reader.lines().map_while(Result::ok) {
                                let trimmed = l.trim();
                                if !trimmed.is_empty() {
                                    on_transcript(trimmed);
                                }
                            }
                        }
                    }
                    last_pos = len;
                } else if len < last_pos {
                    last_pos = 0;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    });
}

/// Inicia la infraestructura de IPC reactivo:
/// 1. Servidor de Named Pipe (Windows) o Unix Socket (Unix).
/// 2. Listener de archivo sólo si se pasó explícitamente `--ipc` o `ZEN_VOICE_IPC_PATH`.
pub fn start_reactive_ipc<F>(on_transcript: F)
where
    F: Fn(&str) + Send + Sync + 'static,
{
    let on_transcript = Arc::new(on_transcript);

    #[cfg(windows)]
    {
        let pipe_name = resolve_pipe_name();
        let on_tx = Arc::clone(&on_transcript);
        tokio::spawn(async move {
            if let Err(e) = run_named_pipe_server(pipe_name, move |t| on_tx(t)).await {
                tracing::error!("Error en Named Pipe server: {}", e);
            }
        });
    }

    #[cfg(unix)]
    {
        let socket_path = resolve_socket_path();
        let on_tx = Arc::clone(&on_transcript);
        tokio::spawn(async move {
            if let Err(e) = run_unix_socket_server(socket_path, move |t| on_tx(t)).await {
                tracing::error!("Error en Unix Socket server: {}", e);
            }
        });
    }

    if let Some(ipc_file) = resolve_ipc_file_path() {
        let on_tx = Arc::clone(&on_transcript);
        spawn_file_fallback_listener(ipc_file, move |t| on_tx(t));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_pipe_name() {
        assert_eq!(normalize_pipe_name("zen_voice_ipc"), r"\\.\pipe\zen_voice_ipc");
        assert_eq!(normalize_pipe_name(r"\\.\pipe\zen_voice_ipc"), r"\\.\pipe\zen_voice_ipc");
        assert_eq!(normalize_pipe_name("//./pipe/zen_voice_ipc"), "//./pipe/zen_voice_ipc");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_named_pipe_reactive_roundtrip() {
        use std::time::Instant;
        use tokio::io::AsyncWriteExt;
        use tokio::net::windows::named_pipe::ClientOptions;
        use tokio::sync::mpsc;

        let test_pipe_name = format!(r"\\.\pipe\zen_test_pipe_{}", std::process::id());
        let (tx, mut rx) = mpsc::channel(10);

        let server_pipe = test_pipe_name.clone();
        tokio::spawn(async move {
            let _ = run_named_pipe_server(server_pipe, move |transcript| {
                let _ = tx.try_send(transcript.to_string());
            }).await;
        });

        // Espera mínima para que el kernel de Windows registre el named pipe
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Cliente conecta y transmite comando
        let mut client = ClientOptions::new().open(&test_pipe_name).expect("Debe conectar al named pipe");
        let start = Instant::now();
        client.write_all(b"guardar cambios\n").await.expect("Debe escribir comando");
        client.flush().await.expect("Debe flushear comando");

        let received = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv())
            .await
            .expect("Timeout esperando recepción reactiva por pipe")
            .expect("Canal no debe estar cerrado");

        let elapsed = start.elapsed();
        assert_eq!(received, "guardar cambios");
        // Verificación empírica: kernel notification sin polling de 15ms
        println!("[IPC REACTIVO TEST] Latencia Named Pipe: {:?}", elapsed);
        assert!(elapsed.as_millis() < 15, "Latencia reactiva esperada < 15ms, obtenida: {:?}", elapsed);

        // Segundo comando en la misma conexión
        client.write_all(b"nueva pestana\n").await.expect("Debe escribir segundo comando");
        client.flush().await.expect("Debe flushear");

        let received2 = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv())
            .await
            .expect("Timeout esperando segundo comando por pipe")
            .expect("Canal no debe estar cerrado");

        assert_eq!(received2, "nueva pestana");
    }

    #[test]
    fn test_file_fallback_listener() {
        use std::sync::mpsc;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join(format!("zen_test_fallback_{}.ipc", std::process::id()));
        let (tx, rx) = mpsc::channel();

        spawn_file_fallback_listener(test_file.clone(), move |t| {
            let _ = tx.send(t.to_string());
        });

        std::thread::sleep(Duration::from_millis(50));

        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&test_file).expect("Abrir archivo");
        writeln!(file, "historial").expect("Escribir a archivo");

        let received = rx.recv_timeout(Duration::from_secs(1)).expect("Recibir de archivo");
        assert_eq!(received, "historial");

        let _ = std::fs::remove_file(&test_file);
    }
}
