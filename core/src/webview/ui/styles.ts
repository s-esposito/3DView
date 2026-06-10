// Injects the viewer's UI stylesheet once. The webview CSP allows inline styles
// ('unsafe-inline'), so a single <style> element keeps all presentation here and
// out of the imperative DOM code. Colors use VS Code theme variables.
// Frosted-glass + motion theme. Surfaces use color-mix to stay theme-aware while
// translucent (so backdrop-filter shows through); all blur/transition/accent work
// is host-agnostic CSS — every host (VS Code, demo, PyCharm) renders it identically.
// "Liquid glass" rim: panels/controls layer many inset box-shadows (bright top-left
// highlights, dark bottom-right shadows) into --glass-shadow / --glass-shadow-sm;
// --glass-reflex-light/dark scale every rim's intensity at once (one knob to tune).
const CSS = `
:root{--viewer-blur:blur(12px) saturate(1.3);--glass-rim-light:#fff;--glass-rim-dark:#000;--glass-reflex-light:.65;--glass-reflex-dark:1;--glass-shadow:inset 0 0 0 1px color-mix(in srgb,var(--glass-rim-light) calc(var(--glass-reflex-light)*10%),transparent),inset 1.8px 3px 0 -2px color-mix(in srgb,var(--glass-rim-light) calc(var(--glass-reflex-light)*90%),transparent),inset -2px -2px 0 -2px color-mix(in srgb,var(--glass-rim-light) calc(var(--glass-reflex-light)*80%),transparent),inset -3px -8px 1px -6px color-mix(in srgb,var(--glass-rim-light) calc(var(--glass-reflex-light)*60%),transparent),inset -0.3px -1px 4px 0 color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*12%),transparent),inset -1.5px 2.5px 0 -2px color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*20%),transparent),inset 0 3px 4px -2px color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*20%),transparent),inset 2px -6.5px 1px -4px color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*10%),transparent),0 1px 5px 0 color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*18%),transparent),0 8px 22px 0 color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*26%),transparent);--glass-shadow-sm:inset 0 0 0 1px color-mix(in srgb,var(--glass-rim-light) calc(var(--glass-reflex-light)*14%),transparent),inset 1px 1.5px 0 -1px color-mix(in srgb,var(--glass-rim-light) calc(var(--glass-reflex-light)*85%),transparent),inset -1px -1.5px 0 -1px color-mix(in srgb,var(--glass-rim-light) calc(var(--glass-reflex-light)*55%),transparent),inset 0 2px 3px -2px color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*22%),transparent),0 1px 2px 0 color-mix(in srgb,var(--glass-rim-dark) calc(var(--glass-reflex-dark)*14%),transparent)}
/* Theme color schemes: override the --vscode-* vars our UI reads (so every rule
   retones with no churn) + the glass-reflex knobs. The viewer also re-reads
   --vscode-editor-background for the 3D viewport on switch. Set on <body> by
   Viewer.setTheme via data-viewer-theme; default applied in the constructor. */
body[data-viewer-theme="light"]{--vscode-editor-background:#e8e8e9;--vscode-editorWidget-background:#ffffff;--vscode-foreground:#1e2436;--vscode-descriptionForeground:#5b6478;--vscode-widget-border:#9aa0ad;--vscode-focusBorder:#0052f5;--vscode-list-hoverBackground:#d6d8de;--vscode-toolbar-hoverBackground:rgba(0,0,0,.07);--vscode-input-background:#dcdde1;--vscode-input-foreground:#1e2436;--vscode-button-background:#0052f5;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#1a64ff;--vscode-button-secondaryBackground:#dcdde1;--vscode-button-secondaryHoverBackground:#cdced3;--vscode-menu-background:#ffffff;--vscode-menu-foreground:#1e2436;--vscode-menu-border:#c7c9cf;--vscode-menu-selectionBackground:#e7e8ec;--glass-reflex-light:.45;--glass-reflex-dark:.6}
body[data-viewer-theme="dark"]{--vscode-editor-background:#1b1b1d;--vscode-editorWidget-background:#242427;--vscode-foreground:#e1e1e1;--vscode-descriptionForeground:#9aa0aa;--vscode-widget-border:#ffffff;--vscode-focusBorder:#03d5ff;--vscode-list-hoverBackground:#ffffff;--vscode-toolbar-hoverBackground:rgba(255,255,255,.13);--vscode-input-background:rgba(255,255,255,.14);--vscode-input-foreground:#e1e1e1;--vscode-button-background:#03d5ff;--vscode-button-foreground:#06283b;--vscode-button-hoverBackground:#54e2ff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryHoverBackground:#4a4e54;--vscode-menu-background:#242427;--vscode-menu-foreground:#e1e1e1;--vscode-menu-border:rgba(255,255,255,.16);--vscode-menu-selectionBackground:rgba(255,255,255,.09);--glass-reflex-light:.5;--glass-reflex-dark:2}
body[data-viewer-theme="dim"]{--vscode-editor-background:#152433;--vscode-editorWidget-background:#1b3149;--vscode-foreground:#d5dbe2;--vscode-descriptionForeground:#8ea3bf;--vscode-widget-border:#99deff;--vscode-focusBorder:#ff48a9;--vscode-list-hoverBackground:#99deff;--vscode-toolbar-hoverBackground:rgba(153,222,255,.15);--vscode-input-background:rgba(153,222,255,.12);--vscode-input-foreground:#d5dbe2;--vscode-button-background:#ff48a9;--vscode-button-foreground:#2a0018;--vscode-button-hoverBackground:#ff6cbb;--vscode-button-secondaryBackground:#21384f;--vscode-button-secondaryHoverBackground:#2b4763;--vscode-menu-background:#1b3149;--vscode-menu-foreground:#d5dbe2;--vscode-menu-border:rgba(153,222,255,.25);--vscode-menu-selectionBackground:rgba(153,222,255,.12);--glass-rim-light:#99deff;--glass-rim-dark:#20001b;--glass-reflex-light:.7;--glass-reflex-dark:2}
.viewer-ui{position:fixed;top:12px;right:12px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;z-index:10}
.viewer-panel{width:222px;font:12px var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#ddd);background:color-mix(in srgb,var(--vscode-editorWidget-background,#1e1e1e) 80%,transparent);backdrop-filter:var(--viewer-blur);-webkit-backdrop-filter:var(--viewer-blur);border:1px solid color-mix(in srgb,var(--vscode-widget-border,#ffffff) 55%,transparent);border-radius:12px;box-shadow:var(--glass-shadow);user-select:none}
.viewer-header{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;border-radius:12px 12px 0 0;transition:background .18s ease}
.viewer-panel.collapsed .viewer-header{border-radius:12px}
.viewer-header:hover{background:color-mix(in srgb,var(--vscode-list-hoverBackground,#ffffff) 55%,transparent)}
.viewer-header:focus-visible{outline:2px solid var(--vscode-focusBorder,#0e639c);outline-offset:-2px}
.viewer-chevron{transition:transform .2s ease;opacity:.7;font-size:10px}
.viewer-panel.collapsed .viewer-chevron{transform:rotate(-90deg)}
.viewer-titles{display:flex;flex-direction:column;line-height:1.3;flex:1;min-width:0}
.viewer-title{font-weight:600;letter-spacing:.2px}
.viewer-sub{color:var(--vscode-descriptionForeground,#999);font-size:11px}
.viewer-panel.collapsed .viewer-sub{display:none}
.viewer-collapse{display:grid;grid-template-rows:1fr;transition:grid-template-rows .26s ease}
.viewer-panel.collapsed .viewer-collapse{grid-template-rows:0fr}
.viewer-clip{overflow:hidden;min-height:0}
.viewer-body{padding:4px 12px 14px}
.viewer-section{margin-top:14px}
.viewer-section-title{text-transform:uppercase;font-size:10px;letter-spacing:.7px;color:var(--vscode-descriptionForeground,#999);margin-bottom:7px}
.viewer-iconbtn{cursor:pointer;border:none;background:transparent;color:var(--vscode-foreground,#ddd);font:inherit;line-height:1;padding:4px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;transition:background .15s ease,transform .1s ease}
.viewer-iconbtn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,0.12))}
.viewer-iconbtn:active{transform:scale(.88)}
.viewer-iconbtn svg{display:block}
.viewer-rename{flex:1;min-width:0;font:inherit;color:var(--vscode-input-foreground,inherit);background:var(--vscode-input-background,rgba(255,255,255,0.08));border:1px solid var(--vscode-focusBorder,#0e639c);border-radius:5px;padding:2px 5px}
.viewer-menuwrap{position:relative}
.viewer-menu{position:absolute;right:0;top:100%;margin-top:6px;min-width:160px;background:color-mix(in srgb,var(--vscode-menu-background,var(--vscode-editorWidget-background,#252526)) 85%,transparent);backdrop-filter:var(--viewer-blur);-webkit-backdrop-filter:var(--viewer-blur);border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,rgba(255,255,255,0.15)));border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.45);z-index:20;overflow:hidden;transform-origin:top right;animation:viewer-pop .14s ease}
.viewer-menu-item{display:block;width:100%;text-align:left;padding:7px 12px;cursor:pointer;border:none;background:transparent;color:var(--vscode-menu-foreground,var(--vscode-foreground,#ddd));font:inherit;transition:background .12s ease}
.viewer-menu-item:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground,rgba(255,255,255,0.08)))}
.viewer-scene-item{display:flex;align-items:center;gap:6px;margin-top:2px;padding:3px 5px;border-radius:6px;transition:background .15s ease}
.viewer-scene-item:hover{background:color-mix(in srgb,var(--vscode-list-hoverBackground,#ffffff) 45%,transparent)}
.viewer-scene-item .label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.viewer-scene-item .kind{opacity:.45;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
.viewer-scene-empty{color:var(--vscode-descriptionForeground,#999);font-style:italic;margin-top:6px}
.viewer-toggles{display:grid;grid-template-columns:1fr 1fr;gap:9px 10px}
.viewer-row{display:flex;align-items:center;gap:8px;cursor:pointer}
.viewer-row input[type=checkbox]{appearance:none;-webkit-appearance:none;margin:0;position:relative;flex:none;width:26px;height:15px;border-radius:8px;background:var(--vscode-input-background,rgba(255,255,255,0.14));box-shadow:var(--glass-shadow-sm);cursor:pointer;transition:background .18s ease}
.viewer-row input[type=checkbox]::before{content:"";position:absolute;top:1px;left:1px;width:11px;height:11px;border-radius:50%;background:var(--vscode-foreground,#ddd);box-shadow:0 1px 2px color-mix(in srgb,var(--glass-rim-dark) 40%,transparent),inset 0 1px 0 color-mix(in srgb,var(--glass-rim-light) 55%,transparent);translate:0;transition:translate .2s cubic-bezier(.5,0,0,1)}
.viewer-row input[type=checkbox]:checked{background:var(--vscode-focusBorder,#0e639c)}
.viewer-row input[type=checkbox]:checked::before{translate:11px 0;background:#fff;animation:viewer-squish .42s ease}
.viewer-seg{position:relative;display:grid;grid-template-columns:repeat(3,1fr);padding:3px;border-radius:99em;background:color-mix(in srgb,var(--vscode-input-background,rgba(255,255,255,0.14)) 55%,transparent);box-shadow:var(--glass-shadow-sm)}
.viewer-seg-thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px)/3);border-radius:99em;background:color-mix(in srgb,var(--vscode-foreground,#ddd) 16%,transparent);box-shadow:var(--glass-shadow-sm);transition:translate .4s cubic-bezier(1,0,.4,1);z-index:0}
.viewer-seg[data-active="light"] .viewer-seg-thumb{translate:0}
.viewer-seg[data-active="dark"] .viewer-seg-thumb{translate:100%}
.viewer-seg[data-active="dim"] .viewer-seg-thumb{translate:200%}
.viewer-seg-thumb.squish{animation:viewer-seg-squish .42s ease}
.viewer-seg-opt{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;height:26px;padding:0;border:none;background:transparent;color:var(--vscode-foreground,#ddd);cursor:pointer;border-radius:99em;transition:color .16s ease}
.viewer-seg-opt svg{width:16px;height:16px;display:block;transition:scale .2s cubic-bezier(.5,0,0,1)}
.viewer-seg-opt:hover{color:var(--vscode-focusBorder,#0e639c)}
.viewer-seg-opt:hover svg{scale:1.18}
.viewer-seg-opt[aria-checked="true"]{color:var(--vscode-focusBorder,#0e639c)}
.viewer-seg-opt[aria-checked="true"] svg{scale:1}
.viewer-slider{display:block;margin-top:12px}
.viewer-slider-head{display:flex;justify-content:space-between;margin-bottom:5px}
.viewer-slider-val{color:var(--vscode-descriptionForeground,#999);font-variant-numeric:tabular-nums}
.viewer-slider input{width:100%;accent-color:var(--vscode-focusBorder,#0e639c);cursor:pointer}
.viewer-btn{display:block;width:100%;margin-top:14px;padding:7px 8px;cursor:pointer;color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#0e639c);border:none;border-radius:6px;font:inherit;font-weight:500;transition:background .15s ease,transform .1s ease,box-shadow .15s ease}
.viewer-btn:hover{background:var(--vscode-button-hoverBackground,#1177bb);transform:translateY(-1px);box-shadow:0 3px 12px rgba(0,0,0,0.3)}
.viewer-btn:active{transform:translateY(0);box-shadow:none}
.viewer-scale-row{display:flex;gap:6px}
.viewer-scale-btn{flex:1;padding:6px 0;cursor:pointer;color:var(--vscode-foreground,#ddd);background:color-mix(in srgb,var(--vscode-button-secondaryBackground,#3a3d41) 70%,transparent);box-shadow:var(--glass-shadow-sm);border-radius:8px;font:inherit;font-variant-numeric:tabular-nums;transition:background .15s ease,transform .1s ease}
.viewer-scale-btn:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground,rgba(255,255,255,0.16)))}
.viewer-scale-btn:active{transform:scale(.96)}
.viewer-hint{margin-top:12px;color:var(--vscode-descriptionForeground,#999);font-style:italic;line-height:1.45}
.viewer-popup{position:fixed;left:12px;bottom:12px;width:300px;font:12px var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#ddd);background:color-mix(in srgb,var(--vscode-editorWidget-background,#1e1e1e) 82%,transparent);backdrop-filter:var(--viewer-blur);-webkit-backdrop-filter:var(--viewer-blur);border:1px solid color-mix(in srgb,var(--vscode-widget-border,#ffffff) 55%,transparent);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.45);overflow:hidden;z-index:10}
.viewer-popup-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;background:color-mix(in srgb,var(--vscode-list-hoverBackground,#ffffff) 40%,transparent)}
.viewer-popup-title{font-weight:600;word-break:break-all}
.viewer-popup-close{cursor:pointer;border:none;background:transparent;color:inherit;font-size:14px;line-height:1;padding:0 4px;border-radius:4px;transition:background .15s ease}
.viewer-popup-close:hover{background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,0.12))}
.viewer-popup img{display:block;width:100%;max-height:50vh;object-fit:contain}
.viewer-popup-body{padding:8px 12px 12px}
.viewer-kv{display:flex;justify-content:space-between;gap:12px;margin-top:3px}
.viewer-kv .k{color:var(--vscode-descriptionForeground,#999)}
.viewer-kv .v{text-align:right;font-variant-numeric:tabular-nums}
.viewer-modal-backdrop{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--vscode-editor-background,#1e1e1e) 55%,transparent);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);animation:viewer-fade .15s ease}
.viewer-modal{width:360px;max-width:100%;max-height:80vh;display:flex;flex-direction:column;font:12px var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#ddd);background:color-mix(in srgb,var(--vscode-editorWidget-background,#1e1e1e) 88%,transparent);backdrop-filter:var(--viewer-blur);-webkit-backdrop-filter:var(--viewer-blur);border:1px solid color-mix(in srgb,var(--vscode-widget-border,#ffffff) 55%,transparent);border-radius:12px;box-shadow:var(--glass-shadow);overflow:hidden;animation:viewer-pop .14s ease}
.viewer-modal-list{overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px}
.viewer-modal-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background .12s ease}
.viewer-modal-row:hover{background:color-mix(in srgb,var(--vscode-list-hoverBackground,#ffffff) 45%,transparent)}
.viewer-modal-row input{flex:none;width:16px;height:16px;accent-color:var(--vscode-focusBorder,#0e639c);cursor:pointer}
.viewer-modal-rowtext{display:flex;flex-direction:column;min-width:0}
.viewer-modal-name{font-weight:600}
.viewer-modal-sub{color:var(--vscode-descriptionForeground,#999);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.viewer-modal-foot{padding:0 12px 12px}
.viewer-btn:disabled{opacity:.5;cursor:default;transform:none;box-shadow:none}
@keyframes viewer-pop{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}
@keyframes viewer-squish{0%{scale:1 1}45%{scale:1.32 1}100%{scale:1 1}}
@keyframes viewer-seg-squish{0%{scale:1 1}45%{scale:1.12 1}100%{scale:1 1}}
.viewer-status{display:inline-flex;align-items:center;gap:10px}
.viewer-spinner{flex:none;width:16px;height:16px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;animation:viewer-spin .8s linear infinite}
@keyframes viewer-spin{to{transform:rotate(360deg)}}
.viewer-drop{position:fixed;inset:0;z-index:30;display:none;align-items:center;justify-content:center;padding:24px;pointer-events:none;background:color-mix(in srgb,var(--vscode-editor-background,#1e1e1e) 55%,transparent);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);animation:viewer-fade .15s ease}
.viewer-drop.active{display:flex}
.viewer-drop-inner{padding:28px 40px;border-radius:14px;border:2px dashed color-mix(in srgb,var(--vscode-focusBorder,#0e639c) 80%,transparent);background:color-mix(in srgb,var(--vscode-editorWidget-background,#1e1e1e) 78%,transparent);color:var(--vscode-foreground,#ddd);font:600 14px var(--vscode-font-family,sans-serif);text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.45)}
@keyframes viewer-fade{from{opacity:0}to{opacity:1}}
`;

export function ensureStyles(): void {
  if (document.getElementById("viewer-styles")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "viewer-styles";
  style.textContent = CSS;
  document.head.appendChild(style);
}
