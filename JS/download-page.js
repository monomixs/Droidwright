/* Windows app download screen.
   The "Download" button in the home header (next to Import SVG) opens a full screen that explains what the Windows
   app adds. Its Download buttons are plain links to the project's GitHub Releases page. */
(function () {
  'use strict';
  const screen = document.getElementById('download-screen');
  const openBtn = document.getElementById('homeDownloadBtn');
  const backBtn = document.getElementById('dlBackBtn');
  if (!screen || !openBtn || !backBtn) return;

  const isOpen = () => !screen.hidden;
  const modalOpen = () => !!(window.DOM && DOM.modalBackdrop && DOM.modalBackdrop.classList.contains('show'));

  function open() {
    try { if (typeof closeModal === 'function') closeModal(); } catch (e) { /* nothing open */ }
    screen.hidden = false;
    document.body.classList.add('download-open');
    screen.scrollTop = 0;
    backBtn.focus({ preventScroll: true });
  }

  function close() {
    screen.hidden = true;
    document.body.classList.remove('download-open');
    openBtn.focus({ preventScroll: true });
  }

  openBtn.addEventListener('click', open);
  backBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !modalOpen()) close();
  });
})();
