/**
 * @file test-nav-parent.js
 * Test unitario con TDD para la interfaz pública de ZenVoiceNavParent.
 * Seam: processCommandIntent(intent)
 */

import assert from "node:assert/strict";

// Mock mínimo de Gecko Services y ChromeUtils
let recentOrganizer = null;
globalThis.Services = {
  prefs: {
    getBoolPref: () => false,
  },
  wm: {
    getMostRecentWindow: (type) => {
      if (type === "Places:Organizer") return recentOrganizer;
      return null;
    },
  },
  scriptSecurityManager: {
    getSystemPrincipal: () => ({}),
  },
};
globalThis.ChromeUtils = {
  importESModule: () => ({}),
};
globalThis.JSWindowActorParent = class {};

// Importar ZenVoiceNavParent
const { ZenVoiceNavParent } = await import("./actors/ZenVoiceNavParent.sys.mjs");

console.log("=== [TDD] Iniciando Tests de ZenVoiceNavParent ===");

// -------------------------------------------------------------
// Test 1: Historial NO debe invocar SidebarUI, debe usar PlacesCommandHook / about:history
// -------------------------------------------------------------
{
  let placesOrganizerFolder = null;
  let sidebarCalled = false;
  const mockWin = {
    PlacesCommandHook: {
      showPlacesOrganizer: (folder) => {
        placesOrganizerFolder = folder;
      },
    },
    SidebarUI: {
      toggle: () => {
        sidebarCalled = true;
      },
      isOpen: false,
    },
  };

  Services.wm.getMostRecentWindow = (type) => {
    if (type === "navigator:browser") return mockWin;
    return null;
  };

  const actor = new ZenVoiceNavParent();
  const res = await actor.processCommandIntent({
    action: "history_action",
    params: { operation: "open_panel" },
    raw_transcript: "abrir historial",
  });

  assert.equal(sidebarCalled, false, "ERROR: SidebarUI.toggle no debe ser llamado en Zen Browser");
  assert.equal(placesOrganizerFolder, "History", "ERROR: PlacesCommandHook.showPlacesOrganizer('History') debió ser invocado");
  assert.equal(res.success, true);
  console.log("✔ Test 1: history_action open_panel usa PlacesCommandHook sin tocar SidebarUI");
}

// -------------------------------------------------------------
// Test 2: Marcadores NO debe invocar SidebarUI, debe usar PlacesCommandHook
// -------------------------------------------------------------
{
  let placesOrganizerFolder = null;
  let sidebarCalled = false;
  const mockWin = {
    PlacesCommandHook: {
      showPlacesOrganizer: (folder) => {
        placesOrganizerFolder = folder;
      },
    },
    SidebarUI: {
      toggle: () => {
        sidebarCalled = true;
      },
      isOpen: false,
    },
  };

  Services.wm.getMostRecentWindow = (type) => {
    if (type === "navigator:browser") return mockWin;
    return null;
  };

  const actor = new ZenVoiceNavParent();
  const res = await actor.processCommandIntent({
    action: "bookmark_action",
    params: { operation: "toggle_sidebar" },
    raw_transcript: "abrir marcadores",
  });

  assert.equal(sidebarCalled, false, "ERROR: SidebarUI.toggle no debe ser llamado en Zen Browser para marcadores");
  assert.equal(placesOrganizerFolder, "AllBookmarks", "ERROR: PlacesCommandHook.showPlacesOrganizer('AllBookmarks') debió ser invocado");
  assert.equal(res.success, true);
  console.log("✔ Test 2: bookmark_action usa PlacesCommandHook sin tocar SidebarUI");
}

// -------------------------------------------------------------
// Test 3: Cierre seguro de pestañas (NUNCA cerrar selectedTab si el target no existe)
// -------------------------------------------------------------
{
  let tabRemoved = null;
  const tabActive = { label: "Trabajo importante", linkedBrowser: { currentURI: { spec: "https://zen-browser.app" } } };
  const mockWin = {
    gBrowser: {
      tabs: [tabActive],
      selectedTab: tabActive,
      removeTab: (t) => {
        tabRemoved = t;
      },
    },
  };

  Services.wm.getMostRecentWindow = (type) => {
    if (type === "navigator:browser") return mockWin;
    return null;
  };

  const actor = new ZenVoiceNavParent();
  const res = await actor.processCommandIntent({
    action: "tab_action",
    params: { operation: "close", target: "descargas" },
    raw_transcript: "cerrar pestaña de descargas",
  });

  assert.equal(tabRemoved, null, "SEGURIDAD CRÍTICA: No se debe cerrar la pestaña activa si la pestaña buscada no existe");
  assert.equal(res.success, false, "El resultado debe ser success: false cuando la pestaña no se encuentra");
  assert.equal(res.reason, "tab_not_found");
  console.log("✔ Test 3: tab_action close no mata selectedTab cuando el target no coincide");
}

// -------------------------------------------------------------
// Test 4: Cierre certero de pestaña por título parcial / dominio
// -------------------------------------------------------------
{
  let tabRemoved = null;
  const tabActive = { label: "Zen Docs", linkedBrowser: { currentURI: { spec: "https://docs.zen-browser.app" } } };
  const tabTarget = { label: "YouTube - Música para programar", linkedBrowser: { currentURI: { spec: "https://www.youtube.com/watch?v=123" } } };
  const mockWin = {
    gBrowser: {
      tabs: [tabActive, tabTarget],
      selectedTab: tabActive,
      removeTab: (t) => {
        tabRemoved = t;
      },
    },
  };

  Services.wm.getMostRecentWindow = (type) => {
    if (type === "navigator:browser") return mockWin;
    return null;
  };

  const actor = new ZenVoiceNavParent();
  const res = await actor.processCommandIntent({
    action: "tab_action",
    params: { operation: "close", target: "youtube" },
    raw_transcript: "cerrar pestaña de youtube",
  });

  assert.equal(tabRemoved, tabTarget, "Debe cerrar la pestaña específica que coincide con 'youtube'");
  assert.equal(mockWin.gBrowser.selectedTab, tabActive, "La pestaña activa debe permanecer inalterada");
  assert.equal(res.success, true);
  console.log("✔ Test 4: tab_action close cierra la pestaña correcta por concordancia de título/dominio");
}

// -------------------------------------------------------------
// Test 5: Conmutación (switch) inteligente de pestañas con normalización de acentos
// -------------------------------------------------------------
{
  const tabActive = { label: "Zen Docs", linkedBrowser: { currentURI: { spec: "https://docs.zen-browser.app" } } };
  const tabTarget = { label: "Configuración del Sistema", linkedBrowser: { currentURI: { spec: "about:preferences" } } };
  const mockWin = {
    gBrowser: {
      tabs: [tabActive, tabTarget],
      selectedTab: tabActive,
    },
  };

  Services.wm.getMostRecentWindow = (type) => {
    if (type === "navigator:browser") return mockWin;
    return null;
  };

  const actor = new ZenVoiceNavParent();
  // El usuario dice "configuracion" sin tilde
  const res = await actor.processCommandIntent({
    action: "tab_action",
    params: { operation: "switch", target: "configuracion" },
    raw_transcript: "ir a pestaña de configuracion",
  });

  assert.equal(mockWin.gBrowser.selectedTab, tabTarget, "Debe conmutar a la pestaña haciendo match con normalización NFD (sin tildes)");
  assert.equal(res.success, true);
  console.log("✔ Test 5: tab_action switch conmuta a la pestaña normalizando acentos");
}

console.log("✅ [TDD RED/GREEN] Todos los tests de la suite pasaron.");
