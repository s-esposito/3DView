// Injects the viewer's UI stylesheet once. The webview CSP allows inline styles
// ('unsafe-inline'), so a single <style> element keeps all presentation here and
// out of the imperative DOM code. Colors use VS Code theme variables.
// Frosted-glass + motion theme. Surfaces use color-mix to stay theme-aware while
// translucent (so backdrop-filter shows through); all blur/transition/accent work
// is host-agnostic CSS — every host (VS Code, demo, PyCharm) renders it identically.
const CSS = `
:root{--viewer-blur:blur(12px) saturate(1.3)}
.viewer-ui{position:fixed;top:12px;right:12px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;z-index:10}
.viewer-panel{width:222px;font:12px var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#ddd);background:color-mix(in srgb,var(--vscode-editorWidget-background,#1e1e1e) 80%,transparent);backdrop-filter:var(--viewer-blur);-webkit-backdrop-filter:var(--viewer-blur);border:1px solid color-mix(in srgb,var(--vscode-widget-border,#ffffff) 55%,transparent);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.06);user-select:none}
.viewer-header{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;border-radius:12px 12px 0 0;transition:background .18s ease}
.viewer-panel.collapsed .viewer-header{border-radius:12px}
.viewer-header:hover{background:color-mix(in srgb,var(--vscode-list-hoverBackground,#ffffff) 55%,transparent)}
.viewer-chevron{transition:transform .2s ease;opacity:.7;font-size:10px}
.viewer-panel.collapsed .viewer-chevron{transform:rotate(-90deg)}
.viewer-titles{display:flex;flex-direction:column;line-height:1.3;flex:1;min-width:0}
.viewer-title{font-weight:600;letter-spacing:.2px}
.viewer-sub{color:var(--vscode-descriptionForeground,#999);font-size:11px}
.viewer-panel.collapsed .viewer-sub{display:none}
.viewer-collapse{display:grid;grid-template-rows:1fr;transition:grid-template-rows .26s ease}
.viewer-panel.collapsed .viewer-collapse{grid-template-rows:0fr}
.viewer-collapse>.viewer-body{overflow:hidden;min-height:0}
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
.viewer-row input[type=checkbox]{appearance:none;-webkit-appearance:none;margin:0;position:relative;flex:none;width:26px;height:15px;border-radius:8px;background:var(--vscode-input-background,rgba(255,255,255,0.14));border:1px solid var(--vscode-widget-border,rgba(255,255,255,0.2));cursor:pointer;transition:background .18s ease,border-color .18s ease}
.viewer-row input[type=checkbox]::before{content:"";position:absolute;top:1px;left:1px;width:11px;height:11px;border-radius:50%;background:var(--vscode-foreground,#ddd);transition:transform .18s ease}
.viewer-row input[type=checkbox]:checked{background:var(--vscode-focusBorder,#0e639c);border-color:var(--vscode-focusBorder,#0e639c)}
.viewer-row input[type=checkbox]:checked::before{transform:translateX(11px);background:#fff}
.viewer-slider{display:block;margin-top:12px}
.viewer-slider-head{display:flex;justify-content:space-between;margin-bottom:5px}
.viewer-slider-val{color:var(--vscode-descriptionForeground,#999);font-variant-numeric:tabular-nums}
.viewer-slider input{width:100%;accent-color:var(--vscode-focusBorder,#0e639c);cursor:pointer}
.viewer-btn{display:block;width:100%;margin-top:14px;padding:7px 8px;cursor:pointer;color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#0e639c);border:none;border-radius:6px;font:inherit;font-weight:500;transition:background .15s ease,transform .1s ease,box-shadow .15s ease}
.viewer-btn:hover{background:var(--vscode-button-hoverBackground,#1177bb);transform:translateY(-1px);box-shadow:0 3px 12px rgba(0,0,0,0.3)}
.viewer-btn:active{transform:translateY(0);box-shadow:none}
.viewer-scale-row{display:flex;gap:6px}
.viewer-scale-btn{flex:1;padding:6px 0;cursor:pointer;color:var(--vscode-foreground,#ddd);background:color-mix(in srgb,var(--vscode-button-secondaryBackground,#3a3d41) 70%,transparent);border:1px solid color-mix(in srgb,var(--vscode-widget-border,#ffffff) 40%,transparent);border-radius:6px;font:inherit;font-variant-numeric:tabular-nums;transition:background .15s ease,transform .1s ease}
.viewer-scale-btn:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground,rgba(255,255,255,0.16)))}
.viewer-scale-btn:active{transform:scale(.96)}
.viewer-hint{margin-top:12px;color:var(--vscode-descriptionForeground,#999);font-style:italic;line-height:1.45}
.viewer-popup{position:fixed;left:12px;bottom:12px;width:300px;font:12px var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#ddd);background:color-mix(in srgb,var(--vscode-editorWidget-background,#1e1e1e) 82%,transparent);backdrop-filter:var(--viewer-blur);-webkit-backdrop-filter:var(--viewer-blur);border:1px solid color-mix(in srgb,var(--vscode-widget-border,#ffffff) 55%,transparent);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.45);overflow:hidden;z-index:10}
.viewer-popup-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;background:color-mix(in srgb,var(--vscode-list-hoverBackground,#ffffff) 40%,transparent)}
.viewer-popup-title{font-weight:600;word-break:break-all}
.viewer-popup-close{cursor:pointer;border:none;background:transparent;color:inherit;font-size:14px;line-height:1;padding:0 4px;border-radius:4px;transition:background .15s ease}
.viewer-popup-close:hover{background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,0.12))}
.viewer-popup img{display:block;width:100%}
.viewer-popup-body{padding:8px 12px 12px}
.viewer-kv{display:flex;justify-content:space-between;gap:12px;margin-top:3px}
.viewer-kv .k{color:var(--vscode-descriptionForeground,#999)}
.viewer-kv .v{text-align:right;font-variant-numeric:tabular-nums}
@keyframes viewer-pop{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}
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
