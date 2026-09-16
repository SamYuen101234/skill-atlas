// Exposes a tiny, explicit native API to the page. Nothing else from Node reaches the renderer.
// Opening and revealing files goes through the HTTP API, which checks the path stays inside the project.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("native", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  onCommand: (cb) => ipcRenderer.on("command", (_e, cmd) => cb(cmd)),
  platform: process.platform,
});
