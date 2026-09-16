// Exposes a tiny, explicit native API to the page. Nothing else from Node reaches the renderer.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("native", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  reveal: (p) => ipcRenderer.invoke("reveal-path", p),
  onCommand: (cb) => ipcRenderer.on("command", (_e, cmd) => cb(cmd)),
  platform: process.platform,
});
