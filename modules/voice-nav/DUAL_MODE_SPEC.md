# Implementación de Variantes: Modo No Videntes vs. Modo Videntes

El módulo `ZenVoiceNav` ahora soporta dos modalidades de interacción independientes o combinadas, configurables a través de la preferencia:

```yaml
zen.voicenav.mode: "screen-reader" # Opciones: "screen-reader" | "visual-overlay" | "both"
```

---

## 1. Variante No Videntes (`mode: "screen-reader"`)

Diseñada para personas ciegas o con baja visión severa que ya utilizan lectores de pantalla (**NVDA, JAWS, Orca**).

* **Sin voz paralela innecesaria:** No superpone un TTS artificial sobre el sintetizador habitual del usuario.
* **Integración nativa vía `accNode.announce()`:**
  Gecko notifica al lector de pantalla mediante el evento `Ci.nsIAccessibleAnnouncementEvent.POLITE`:
  ```javascript
  accNode.announce(`clic: Guardar cambios`, Ci.nsIAccessibleAnnouncementEvent.POLITE);
  ```
* **Mantenimiento del foco de accesibilidad (`takeFocus`):** Al saltar a un campo de texto o activar un enlace, el cursor del lector de pantalla se sincroniza automáticamente con el nuevo elemento.
* **Barge-in instantáneo (<20ms):** El Silero VAD del motor en Rust corta cualquier audio del sistema en cuanto detecta voz humana.

---

## 2. Variante Videntes / Manos Libres (`mode: "visual-overlay"`)

Diseñada para productividad sin manos, personas con movilidad reducida o usuarios en entornos ruidosos.

* **Feedback silencioso:** Cero anuncios auditivos para no interrumpir música, llamadas o concentración.
* **Badges numéricos y contextuales (`showVisualOverlay`):**
  Pinta badges flotantes discretos estilo *Vimium* sobre las coordenadas exactas de cada elemento accionable (`bounds` CSS):
  ```text
  [1: Guardar]   [2: Cancelar]   [3: Configuración]
  ```
* **Destello de confirmación (`highlightElement`):**
  Aplica un *focus ring* transitorio de 400ms (`3px solid #0969da`) sobre el elemento que fue activado por voz para dar confirmación visual inmediata sin mover el puntero del mouse.

---

## 3. Modo Híbrido (`mode: "both"`)

Ejecuta simultáneamente el anuncio en el lector de pantalla y el destello visual en pantalla, ideal para entornos educativos o usuarios con visión parcial asistida.
