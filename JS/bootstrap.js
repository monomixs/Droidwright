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
  wireLayerList();
  wireMisc();
  wireHome();
  initSettings();
  refreshShortcutTooltips();
  syncDocSettingsUI();
  fitZoom();
  renderAll();
  document.body.classList.add('home-visible');
  renderHome();
  maybeShowWelcomeModal();
  wireMobileBlock();
  wireReferencePanel();
  initNumberSteppers();
}
if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

