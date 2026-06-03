// Injects the viewer's UI stylesheet once. The webview CSP allows inline styles
// ('unsafe-inline'), so a single <style> element keeps all presentation here and
// out of the imperative DOM code. Colors use VS Code theme variables.
const CSS = `
.viewer-panel{position:fixed;top:12px;right:12px;width:214px;font:12px var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#ddd);background:var(--vscode-editorWidget-background,rgba(30,30,30,0.92));border:1px solid var(--vscode-widget-border,rgba(255,255,255,0.12));border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.35);user-select:none;overflow:hidden}
.viewer-panel.collapsed{width:auto}
.viewer-header{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer}
.viewer-header:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,0.05))}
.viewer-chevron{transition:transform .15s ease;opacity:.8;font-size:10px}
.viewer-panel.collapsed .viewer-chevron{transform:rotate(-90deg)}
.viewer-titles{display:flex;flex-direction:column;line-height:1.25}
.viewer-title{font-weight:600}
.viewer-sub{color:var(--vscode-descriptionForeground,#999);font-size:11px}
.viewer-panel.collapsed .viewer-sub{display:none}
.viewer-body{padding:2px 12px 12px}
.viewer-panel.collapsed .viewer-body{display:none}
.viewer-section{margin-top:12px}
.viewer-section-title{text-transform:uppercase;font-size:10px;letter-spacing:.6px;color:var(--vscode-descriptionForeground,#999);margin-bottom:6px}
.viewer-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.viewer-section-head .viewer-section-title{margin-bottom:0}
.viewer-iconbtn{cursor:pointer;border:none;background:transparent;color:var(--vscode-foreground,#ddd);font:inherit;line-height:1;padding:2px 5px;border-radius:4px}
.viewer-iconbtn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,0.12))}
.viewer-menuwrap{position:relative}
.viewer-menu{position:absolute;right:0;top:100%;margin-top:4px;min-width:150px;background:var(--vscode-menu-background,var(--vscode-editorWidget-background,#252526));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,rgba(255,255,255,0.15)));border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.4);z-index:20;overflow:hidden}
.viewer-menu-item{display:block;width:100%;text-align:left;padding:6px 10px;cursor:pointer;border:none;background:transparent;color:var(--vscode-menu-foreground,var(--vscode-foreground,#ddd));font:inherit}
.viewer-menu-item:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground,rgba(255,255,255,0.08)))}
.viewer-scene-item{display:flex;align-items:center;gap:6px;margin-top:4px}
.viewer-scene-item .label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.viewer-scene-item .kind{opacity:.5;font-size:10px;text-transform:uppercase}
.viewer-scene-empty{color:var(--vscode-descriptionForeground,#999);font-style:italic;margin-top:4px}
.viewer-toggles{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px}
.viewer-row{display:flex;align-items:center;gap:6px;cursor:pointer}
.viewer-row input{margin:0}
.viewer-slider{display:block;margin-top:10px}
.viewer-slider-head{display:flex;justify-content:space-between;margin-bottom:3px}
.viewer-slider-val{color:var(--vscode-descriptionForeground,#999);font-variant-numeric:tabular-nums}
.viewer-slider input{width:100%}
.viewer-btn{display:block;width:100%;margin-top:12px;padding:5px 8px;cursor:pointer;color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#0e639c);border:none;border-radius:4px;font:inherit}
.viewer-btn:hover{background:var(--vscode-button-hoverBackground,#1177bb)}
.viewer-hint{margin-top:12px;color:var(--vscode-descriptionForeground,#999);font-style:italic;line-height:1.45}
.viewer-back{position:fixed;top:12px;left:12px;width:auto;margin:0;z-index:10}
.viewer-popup{position:fixed;left:12px;bottom:12px;width:300px;font:12px var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#ddd);background:var(--vscode-editorWidget-background,rgba(30,30,30,0.94));border:1px solid var(--vscode-widget-border,rgba(255,255,255,0.15));border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.4);overflow:hidden;z-index:10}
.viewer-popup-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;background:var(--vscode-list-hoverBackground,rgba(255,255,255,0.05))}
.viewer-popup-title{font-weight:600;word-break:break-all}
.viewer-popup-close{cursor:pointer;border:none;background:transparent;color:inherit;font-size:14px;line-height:1;padding:0 2px}
.viewer-popup-close:hover{opacity:.7}
.viewer-popup img{display:block;width:100%}
.viewer-popup-body{padding:8px 12px 12px}
.viewer-kv{display:flex;justify-content:space-between;gap:12px;margin-top:3px}
.viewer-kv .k{color:var(--vscode-descriptionForeground,#999)}
.viewer-kv .v{text-align:right;font-variant-numeric:tabular-nums}
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
