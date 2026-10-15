# zenKev Voice Navigator — Guía para Beta Testers

Bienvenido a la versión Beta de **zenKev Voice Navigator**, el sistema de navegación por voz nativo y accesible para **Zen Browser**.

---

## 🚀 Requisitos Previos

### 1. Para Navegación por Voz Básica (Modo Predeterminado Ultra-rápido en CPU)
* **Zen Browser** instalado en tu computadora (Windows x64 o macOS Apple Silicon/Intel).
* **Python 3.10, 3.11, 3.12 o 3.13** instalado:
  * En Windows: asegúrate de marcar la casilla *"Add python.exe to PATH"*.
  * En macOS: instalado mediante [python.org](https://www.python.org/) o con Homebrew (`brew install python`).
* Un micrófono funcional conectado.
* **Nota importante sobre Python**: No uses versiones en desarrollo o alpha (como 3.14 o 3.15). Recomendamos **Python 3.12**: [Descargar Python 3.12](https://www.python.org/downloads/release/python-3.12-8/).

### 2. Para Inferencia Avanzada de IA (Modo Sistema 2 con Kev-4B v6)
* **Python 3.12 o 3.13** (PyTorch no cuenta con soporte ni binarios compilados para versiones superiores a 3.13).
* **Git** instalado y en el PATH: [Descargar Git](https://git-scm.com/download/).
  *(Requerido por pip para descargar e instalar el framework `kev` de inferencia).*
* Conexión a Internet (para descargar las librerías de IA y el modelo desde Hugging Face en el primer inicio).

---

## ⚡ Instalación en 1 Clic

1. Descarga el paquete o clona el repositorio:
   ```bash
   git clone https://github.com/Totopo27/zenKev.git
   ```
2. **¡IMPORTANTE!** Si descargaste un `.zip`, descomprímelo en una carpeta de tu preferencia antes de ejecutar.
3. Cierra Zen Browser si lo tienes abierto.
4. **Ejecutar el instalador en 1 clic**:
   * **En Windows**: Haz doble clic en **`instalar_zenkev.bat`**.
   * **En macOS**: Haz doble clic en **`instalar_zenkev.command`** en Finder (o ejecuta `./instalar_zenkev.command` desde la Terminal).
   * El asistente detectará automáticamente tu navegador (en `/Applications` en Mac o en `Program Files`/Escritorio en Windows).
   * Verificará e instalará automáticamente las dependencias de audio de Python necesarias.
   * Configurará de forma autónoma las preferencias en tu perfil de Zen Browser.
   * Creará una copia de seguridad segura de tu archivo original `omni.ja` y parcheará los módulos de voz.

---

## 🎙️ Cómo Usarlo en Zen Browser

### Opción A: Probar con el Entorno Todo-en-Uno (Recomendado para Pruebas)
* **En Windows**: Haz doble clic en **`iniciar_prueba_zenkev.bat`**.
* **En macOS**: Haz doble clic en **`iniciar_prueba_zenkev.command`**.
* Levantará el servidor de IA local si está disponible.
* Abrirá Zen Browser con la página de pruebas interactiva `test-page.html`.
* Te ofrecerá activar el micrófono en vivo en segundo plano.

### Opción B: Uso Directo Diario en Zen Browser
1. Abre Zen Browser normalmente.
2. Ejecuta **`zen_live_mic.py`** (o presiona **`Alt + V`** dentro del navegador).
3. Habla directamente por tu micrófono físico sin tocar el teclado ni el ratón.

---

## 🗣️ Comandos de Voz Disponibles (Prueba hablando en voz alta)

### Navegación y Control del Navegador:
* `"inicio"` (ir a la página de inicio)
* `"configuración"` o `"ajustes"`
* `"descargas"`
* `"historial"`
* `"nueva pestaña"` o `"abrir pestaña"`
* `"cerrar pestaña"`
* `"siguiente pestaña"` / `"pestaña anterior"`
* `"abrir [sitio]"` (ej. *"abrir youtube"*, *"abrir wikipedia"*, *"abrir github"*)
* `"buscar [consulta]"` (ej. *"buscar clima en Buenos Aires"*)
* `"bajar"` / `"subir"` / `"arriba del todo"` / `"al fondo"` (scroll)

### Interacción con la Página Web:
* Puedes decir directamente el texto de cualquier botón o enlace visible (ej. *"guardar cambios"*, *"cancelar"*, *"comprar"*).
* **Badges Numéricos**: Presiona **`F2`** para mostrar números sobre todos los elementos interactivos en pantalla y di simplemente el número (ej. *"3"*, *"el 5"*, *"hacer clic en 2"*).

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
   * *Compatibilidad garantizada*: Si tu tarjeta gráfica tiene una arquitectura muy nueva y tu versión de PyTorch es anterior, el servidor activa un **fallback automático a CPU** para garantizar que siga funcionando sin crashear.
3. Abre Zen Browser normalmente: el navegador detectará automáticamente el servidor y delegará las decisiones complejas a Kev-4B v6.

---

## ❓ Preguntas Frecuentes / Solución de Problemas

* **¿Por qué en el Administrador de Tareas no veo consumo de GPU/CPU al usar Kev-4B?**
  Kev-4B v6 no es un chatbot que genera texto durante segundos. Es un clasificador NLI ultra-rápido que resuelve la intención en un único paso de ~15-30 milisegundos. En reposo consume 0% y durante la inferencia es tan veloz que no alcanza a mover el medidor de Windows.
* **Al hacer clic en "Dictar" en la página de prueba me salía un aviso:**
  La API Web Speech es exclusiva de navegadores basados en Chromium. Zen Browser utiliza el motor nativo **zen_live_mic.py** en segundo plano, por lo que no necesitas presionar botones en la web: habla directamente a tu micrófono.
* **En macOS no me reconoce la voz al hablar:**
  macOS bloquea la captura de audio por defecto. Asegúrate de que tu aplicación de **Terminal** tenga la casilla de acceso al Micrófono activada en: *Ajustes del Sistema -> Privacidad y Seguridad -> Micrófono*.
* **Si Zen Browser está instalado en el Escritorio o una carpeta no estándar:**
  El instalador detecta accesos directos, registros y carpetas estándar automáticamente. En macOS revisa `/Applications` y `~/Applications`.

---

## 🔄 Cómo Desinstalar

Si deseas volver al estado 100% de fábrica de Zen Browser en cualquier momento:
* **En Windows**: Haz doble clic en **`desinstalar_zenkev.bat`**.
* **En macOS**: Haz doble clic en **`desinstalar_zenkev.command`** (o ejecútalo en Terminal).
* Tu navegador recuperará su respaldo original sin dejar archivos residuales.
