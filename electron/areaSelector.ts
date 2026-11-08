import { BrowserWindow, ipcMain, type Display } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Directory of the bundled main process (the preload script sits next to it).
const bundleDirectory = path.dirname(fileURLToPath(import.meta.url))

export type AreaRect = {
  x: number
  y: number
  width: number
  height: number
}

const MIN_SIZE = 32

let activeSelection: Promise<AreaRect | null> | null = null

const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; width: 100%; height: 100%; overflow: hidden;
    background: transparent; user-select: none; -webkit-user-select: none;
    font-family: "Segoe UI", system-ui, sans-serif;
  }
  body { cursor: crosshair; }
  #dim {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.62);
  }
  #box {
    position: fixed; display: none; box-sizing: border-box;
    border: 2px solid #ef4444;
    box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.62);
    cursor: move;
  }
  #size {
    position: fixed; display: none; padding: 4px 10px; border-radius: 8px;
    background: rgba(24, 24, 27, 0.92); color: #fff; font-size: 12px;
    font-weight: 600; letter-spacing: 0.02em; pointer-events: none;
    white-space: nowrap;
  }
  #actions {
    position: fixed; display: none; gap: 8px;
  }
  #actions button {
    border: 0; border-radius: 9px; padding: 8px 16px; font-size: 12px;
    font-weight: 700; cursor: pointer; font-family: inherit;
  }
  #confirm { background: #ef4444; color: #fff; }
  #cancel { background: rgba(39, 39, 42, 0.95); color: #e4e4e7; }
  #hint {
    position: fixed; top: 28px; left: 50%; transform: translateX(-50%);
    padding: 9px 18px; border-radius: 12px; background: rgba(24, 24, 27, 0.92);
    color: #fff; font-size: 13px; pointer-events: none; white-space: nowrap;
  }
  #hint b { color: #f87171; }
</style>
</head>
<body>
<div id="dim"></div>
<div id="box"></div>
<div id="size"></div>
<div id="actions">
  <button id="cancel" type="button">Cancel</button>
  <button id="confirm" type="button">Start Area</button>
</div>
<div id="hint">Drag to select the area to record &middot; <b>Enter</b> confirm &middot; <b>Esc</b> cancel</div>
<script>
(() => {
  const MIN = ${MIN_SIZE};
  const dim = document.getElementById('dim');
  const box = document.getElementById('box');
  const sizeLabel = document.getElementById('size');
  const actions = document.getElementById('actions');
  const hint = document.getElementById('hint');

  let rect = null;       // committed selection {x, y, w, h}
  let mode = 'idle';     // idle | drawing | moving
  let anchor = null;
  let moveOffset = null;

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function normalize(a, b) {
    const x1 = clamp(Math.min(a.x, b.x), 0, window.innerWidth);
    const y1 = clamp(Math.min(a.y, b.y), 0, window.innerHeight);
    const x2 = clamp(Math.max(a.x, b.x), 0, window.innerWidth);
    const y2 = clamp(Math.max(a.y, b.y), 0, window.innerHeight);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function render(final) {
    if (!rect || rect.w < 1 || rect.h < 1) {
      box.style.display = 'none';
      sizeLabel.style.display = 'none';
      actions.style.display = 'none';
      dim.style.display = 'block';
      return;
    }

    dim.style.display = 'none';
    box.style.display = 'block';
    box.style.left = rect.x + 'px';
    box.style.top = rect.y + 'px';
    box.style.width = rect.w + 'px';
    box.style.height = rect.h + 'px';

    const scale = window.devicePixelRatio || 1;
    sizeLabel.textContent = Math.round(rect.w * scale) + ' \\u00d7 ' + Math.round(rect.h * scale);
    sizeLabel.style.display = 'block';
    const labelTop = rect.y > 34 ? rect.y - 32 : rect.y + 6;
    sizeLabel.style.left = rect.x + 'px';
    sizeLabel.style.top = labelTop + 'px';

    if (final) {
      actions.style.display = 'flex';
      const below = rect.y + rect.h + 12;
      const top = below + 40 < window.innerHeight ? below : Math.max(8, rect.y - 52);
      actions.style.top = top + 'px';
      actions.style.left = clamp(rect.x + rect.w - 170, 8, window.innerWidth - 190) + 'px';
    } else {
      actions.style.display = 'none';
    }
  }

  function confirm() {
    if (!rect || rect.w < MIN || rect.h < MIN) return;
    window.areaApi.confirm({
      x: rect.x, y: rect.y, width: rect.w, height: rect.h,
    });
  }

  function cancel() { window.areaApi.cancel(); }

  window.addEventListener('mousedown', (event) => {
    if (event.button === 2) {
      if (rect) { rect = null; render(false); hint.style.display = 'block'; }
      else { cancel(); }
      return;
    }
    if (event.button !== 0) return;
    if (event.target.closest && event.target.closest('#actions')) return;

    const point = { x: event.clientX, y: event.clientY };
    const inside = rect &&
      point.x >= rect.x && point.x <= rect.x + rect.w &&
      point.y >= rect.y && point.y <= rect.y + rect.h;

    hint.style.display = 'none';

    if (inside) {
      mode = 'moving';
      moveOffset = { x: point.x - rect.x, y: point.y - rect.y };
    } else {
      mode = 'drawing';
      anchor = point;
      rect = { x: point.x, y: point.y, w: 0, h: 0 };
    }
    render(false);
  });

  window.addEventListener('mousemove', (event) => {
    if (mode === 'drawing') {
      rect = normalize(anchor, { x: event.clientX, y: event.clientY });
      render(false);
    } else if (mode === 'moving' && rect) {
      rect.x = clamp(event.clientX - moveOffset.x, 0, window.innerWidth - rect.w);
      rect.y = clamp(event.clientY - moveOffset.y, 0, window.innerHeight - rect.h);
      render(false);
    }
  });

  window.addEventListener('mouseup', () => {
    if (mode === 'idle') return;
    mode = 'idle';
    if (!rect || rect.w < MIN || rect.h < MIN) {
      rect = null;
      hint.style.display = 'block';
      render(false);
      return;
    }
    render(true);
  });

  window.addEventListener('dblclick', () => { confirm(); });
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel();
    if (event.key === 'Enter') confirm();
  });

  document.getElementById('confirm').addEventListener('click', confirm);
  document.getElementById('cancel').addEventListener('click', cancel);
  render(false);
})();
</script>
</body>
</html>`

/**
 * Shows a dark overlay on the given display and lets the user drag a
 * rectangle with the mouse. Resolves with the rectangle in DIPs relative
 * to the display's top-left corner, or null when cancelled.
 */
export function selectCaptureArea(display: Display, language: 'en' | 'fa' = 'en'): Promise<AreaRect | null> {
  if (activeSelection) return activeSelection

  const selection = new Promise<AreaRect | null>((resolve) => {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      focusable: true,
      title: 'SUPER RECORD Area Selection',
      webPreferences: {
        preload: path.join(bundleDirectory, 'preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    let settled = false

    const finish = (value: AreaRect | null) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('area:confirm', onConfirm)
      ipcMain.removeListener('area:cancel', onCancel)
      if (!overlay.isDestroyed()) overlay.destroy()
      resolve(value)
    }

    const isFromOverlay = (event: Electron.IpcMainEvent) =>
      !overlay.isDestroyed() && event.sender === overlay.webContents

    const onConfirm = (event: Electron.IpcMainEvent, rect: unknown) => {
      if (!isFromOverlay(event)) return
      const value = rect as Partial<AreaRect> | null
      if (
        !value ||
        !Number.isFinite(value.x) ||
        !Number.isFinite(value.y) ||
        !Number.isFinite(value.width) ||
        !Number.isFinite(value.height)
      ) {
        finish(null)
        return
      }

      const width = Math.min(Math.round(value.width!), display.bounds.width)
      const height = Math.min(Math.round(value.height!), display.bounds.height)
      const x = Math.max(0, Math.min(Math.round(value.x!), display.bounds.width - width))
      const y = Math.max(0, Math.min(Math.round(value.y!), display.bounds.height - height))

      finish(width >= MIN_SIZE && height >= MIN_SIZE ? { x, y, width, height } : null)
    }

    const onCancel = (event: Electron.IpcMainEvent) => {
      if (isFromOverlay(event)) finish(null)
    }

    ipcMain.on('area:confirm', onConfirm)
    ipcMain.on('area:cancel', onCancel)

    overlay.on('closed', () => finish(null))
    overlay.webContents.on('render-process-gone', () => finish(null))

    overlay.once('ready-to-show', () => {
      // Re-apply the bounds after creation: some DPI configurations shift
      // transparent windows during creation.
      overlay.setBounds(display.bounds)
      overlay.setAlwaysOnTop(true, 'screen-saver')
      overlay.show()
      overlay.focus()
    })

    // Losing focus (for example via Alt+Tab) cancels the selection so the
    // overlay can never get stuck on top of the screen.
    overlay.on('blur', () => {
      setTimeout(() => {
        if (!settled && !overlay.isDestroyed() && !overlay.isFocused()) finish(null)
      }, 250)
    })

    // Persian texts for the overlay. Only the visible words change.
    if (language === 'fa') {
      overlay.webContents.once('did-finish-load', () => {
        void overlay.webContents
          .executeJavaScript(
            `(() => {
              document.getElementById('cancel').textContent = '\u0644\u063a\u0648';
              document.getElementById('confirm').textContent = '\u0634\u0631\u0648\u0639 \u0636\u0628\u0637 \u0646\u0627\u062d\u06cc\u0647';
              const hint = document.getElementById('hint');
              hint.dir = 'rtl';
              hint.innerHTML = '\u0628\u0631\u0627\u06cc \u0627\u0646\u062a\u062e\u0627\u0628 \u0646\u0627\u062d\u06cc\u0647 \u0628\u06a9\u0634\u06cc\u062f &middot; <b>Enter</b> \u062a\u0623\u06cc\u06cc\u062f &middot; <b>Esc</b> \u0644\u063a\u0648';
            })()`,
          )
          .catch(() => undefined)
      })
    }

    void overlay.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`,
    )
  })

  activeSelection = selection.finally(() => {
    activeSelection = null
  })

  return activeSelection
}
