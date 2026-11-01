function init(){
  cacheDom();
  buildStageSkeleton();
  wireTopbar();
  wireRail();
  wirePanelVisibility();
  wireTabs();
  wireXmlEditor();
  wirePanelResize();
  wireCanvasEvents();
  wireCanvasHoverOutline();
  wireContextMenu();
  wireBooleanPopover();
  wireExportPopover();
  wireFontBrowserPopover();
  wirePresetShapesPopover();
  wireDocSettings();
  wireSelectionPanels();
  wireCustomColorPickers();
  wireCustomDropdowns();
  wireLayerList();
  wireMisc();
  wireHome();
  Workspace.wire();
  initSettings();
  refreshShortcutTooltips();
  syncDocSettingsUI();
  fitZoom();
  renderAll();
  document.body.classList.add('home-visible');
  renderHome();
  // First run of the Windows app: setup comes first, and the welcome popup follows it.
  if (!maybeShowOnboarding()) maybeShowWelcomeModal();
  wireMobileBlock();
  wireReferencePanel();
  initNumberSteppers();
}
// In the Windows app the projects are files, so wait until the Projects folder has been read (otherwise the home
// screen would flash up empty). In a browser ProjectStore.ready is already resolved.
function start(){
  Promise.resolve(ProjectStore.ready).catch(() => {}).then(() => {
    init();
    if (window.NativeBridge && window.NativeBridge.notifyReady) window.NativeBridge.notifyReady();   // files Windows wants opened can now be delivered
  });
}
if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}