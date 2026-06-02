# 3DViewer

A Visual Studio Code extension to view COLMAP reconstructions directly in the
editor as a colored point cloud with camera poses. Inspired by the
[viser COLMAP visualizer](https://viser.studio/main/examples/demos/colmap_visualizer/).

> **Status:** foundation scaffold. The project builds and runs, opening an empty
> viewer panel. COLMAP parsing and 3D rendering are not implemented yet.

## Architecture

The extension has two halves that communicate over `postMessage`:

| Part | Runs in | Source | Bundle |
|------|---------|--------|--------|
| Extension host | Node.js | `src/extension.ts`, `src/panel.ts` | `out/extension.js` |
| Webview UI | Browser (iframe) | `src/webview/main.ts` | `out/webview.js` |

Shared message types live in `src/messages.ts`. `esbuild.js` produces both
bundles.

## Develop

```bash
npm install
npm run build      # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, then run
the **3DViewer: Open Reconstruction** command from the Command Palette.

## Roadmap

- [ ] Parse COLMAP models (`cameras`, `images`, `points3D`; binary + text)
- [ ] Render colored point cloud (Three.js)
- [ ] Render camera frustums / poses
- [ ] Open a reconstruction folder from a command / context menu
