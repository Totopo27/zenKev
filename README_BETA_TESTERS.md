# zenKev Voice Navigator — Guía para Beta Testers

Bienvenido a la versión Beta de **zenKev Voice Navigator**, el sistema de navegación por voz nativo y accesible para **Zen Browser**.

---

## 🚀 Requisitos Previos

1. **Zen Browser** instalado en tu computadora (Windows x64).
2. **Python 3.10 o superior** instalado (asegúrate de marcar la opción *"Add python.exe to PATH"* durante la instalación).
3. Un micrófono funcional conectado.

---

## ⚡ Instalación en 1 Clic

1. Descarga el paquete de Release (`zenkev-beta.zip`) y descomprímelo en una carpeta de tu preferencia.
2. Cierra Zen Browser si lo tienes abierto.
3. Haz doble clic en el archivo **`instalar_zenkev.bat`**.
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

## 🔄 Cómo Desinstalar

Si deseas volver al estado 100% de fábrica de Zen Browser en cualquier momento:
1. Haz doble clic en **`desinstalar_zenkev.bat`**.
2. Tu navegador recuperará su respaldo original sin dejar archivos residuales.
