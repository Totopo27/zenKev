# zenKev Voice Navigator — Guía para Beta Testers

Bienvenido a la versión Beta de **zenKev Voice Navigator**, el sistema de navegación por voz nativo y accesible para **Zen Browser**.

---

## 🚀 Requisitos Previos

### 1. Para Navegación por Voz Básica (Modo Predeterminado Ultra-rápido en CPU)
* **Zen Browser** instalado en tu computadora (Windows x64).
* **Python 3.10, 3.11, 3.12 o 3.13** instalado (asegúrate de marcar la casilla *"Add python.exe to PATH"*).
* Un micrófono funcional conectado.
* **Nota importante sobre Python**: No uses versiones en desarrollo o alpha (como 3.14 o 3.15). Recomendamos **Python 3.12**: [Descargar Python 3.12](https://www.python.org/downloads/release/python-3.12-8/).

### 2. Para Inferencia Avanzada de IA (Modo Sistema 2 con Kev-4B v6)
* **Python 3.12 o 3.13** (PyTorch no cuenta con soporte ni binarios compilados para versiones superiores a 3.13).
* **Git para Windows** instalado y en el PATH: [Descargar Git para Windows](https://git-scm.com/download/win).
  *(Requerido por pip para descargar e instalar el framework `kev` de inferencia).*
* Conexión a Internet (para descargar las librerías de IA y el modelo desde Hugging Face en el primer inicio).

---

## ⚡ Instalación en 1 Clic

1. Descarga el paquete de Release (`zenkev-v0.1-beta.zip`).
2. **¡IMPORTANTE!** Haz clic derecho sobre el archivo `.zip` y selecciona **«Extraer todo...»** en una carpeta de tu preferencia. *(No ejecutes los archivos directamente dentro del visor de ZIP de Windows).*
3. Cierra Zen Browser si lo tienes abierto.
4. Haz doble clic en el archivo **`instalar_zenkev.bat`**.
   * El asistente detectará automáticamente tu navegador.
   * Instalará las dependencias de audio necesarias (`sounddevice`, `numpy`, `SpeechRecognition`).
   * Creará una copia de seguridad segura de tu archivo original `omni.ja`.
   * Parcheará los actores de voz e iniciará Zen Browser con la caché limpia.

---

## 🎙️ Cómo Usarlo en Zen Browser

* **Activar / Silenciar el micrófono y panel**: Presiona **`Alt + V`** en cualquier momento dentro de Zen Browser.
  * Escucharás un tono de audio de apertura.
  * Aparecerá el panel flotante **zenKev Control** en la esquina superior derecha.
* **Comandos de voz rápidos** (pruébalos hablando en voz alta):
  * `"abrir pestaña"`
  * `"cerrar pestaña"`
  * `"abrir facebook"` / `"abrir wikipedia"` / `"abrir youtube"`
  * `"inicio"` / `"configuración"`
  * `"bajar"` / `"subir"` (desplazamiento)
* **Badges Numéricos**: Presiona **`F2`** para mostrar números sobre todos los enlaces y botones en pantalla para activarlos por número.

---

## 🧠 Modos de Inferencia: ¿Cómo opera la IA?

El sistema cuenta con dos niveles de inteligencia integrados:

### 1. Modo Predeterminado (CPU Ultra-rápido, <3 ms)
* **No requiere descargas pesadas ni tarjeta de video dedicada.**
* Resuelve navegación de pestañas, ventanas, URLs y clics semánticos directamente en la CPU mediante el motor compilado en Rust.

### 2. Modo Sistema 2 con Kev-4B v6 (Inferencia Profunda)
Si quieres probar el razonamiento completo con el modelo fine-tuned **[Ttotopo27/zenkev-v6](https://huggingface.co/Ttotopo27/zenkev-v6)**:
1. Haz doble clic en **`iniciar_servidor_kev.bat`**.
2. El script levantará el puente de inferencia en el puerto 8080 (descargando automáticamente los pesos desde Hugging Face si no los tienes).
3. Abre Zen Browser normalmente: el navegador detectará automáticamente el servidor y delegará las decisiones complejas a Kev-4B v6.

---

## 🔄 Cómo Desinstalar

Si deseas volver al estado 100% de fábrica de Zen Browser en cualquier momento:
1. Haz doble clic en **`desinstalar_zenkev.bat`**.
2. Tu navegador recuperará su respaldo original sin dejar archivos residuales.
