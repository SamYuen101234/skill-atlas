// Electron shell: runs the same express server on a loopback port and shows the UI in a window.
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeTheme } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let win = null;
let baseUrl = null;

function send(cmd) {
  win?.webContents.send("command", cmd);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Open in Browser", click: () => shell.openExternal(baseUrl) },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Add Project…", accelerator: "CmdOrCtrl+O", click: () => send("add-project") },
        { label: "Scan Global Config", accelerator: "CmdOrCtrl+G", click: () => send("scan-global") },
        { label: "Rescan Project", accelerator: "CmdOrCtrl+R", click: () => send("rescan") },
        { type: "separator" },
        { label: "Release Plugin…", accelerator: "CmdOrCtrl+Shift+R", click: () => send("release") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "List", accelerator: "CmdOrCtrl+1", click: () => send("view:list") },
        { label: "Flow", accelerator: "CmdOrCtrl+2", click: () => send("view:flow") },
        { label: "Network", accelerator: "CmdOrCtrl+3", click: () => send("view:graph") },
        { type: "separator" },
        { label: "Search", accelerator: "CmdOrCtrl+F", click: () => send("focus-search") },
        { type: "separator" },
        ...(isDev ? [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }] : []),
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Skill Atlas",
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1117" : "#f5f6fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(baseUrl);
  // External links open in the default browser, never inside the app window. Only web
  // URLs are handed to the OS: file:, custom schemes etc. from a compromised page are dropped.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (ev, url) => { if (!url.startsWith(baseUrl)) ev.preventDefault(); });
  win.on("closed", () => { win = null; });
}

// First launch from a source checkout: carry over the browser-mode project list.
async function seedFromDevData(dataDir) {
  if (!isDev) return;
  const src = path.join(__dirname, "data", "projects.json");
  const dst = path.join(dataDir, "projects.json");
  try { await fs.access(dst); return; } catch { /* not seeded yet */ }
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.copyFile(src, dst);
    console.log(`Seeded ${dst} from ${src}`);
  } catch { /* nothing to seed */ }
}

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath("userData"), "data");
  await seedFromDevData(dataDir);
  const { port, host } = await startServer({ dataDir, port: 0, host: "127.0.0.1" });
  baseUrl = `http://${host}:${port}`;
  console.log(`Skill Atlas listening on ${baseUrl} (data: ${dataDir})`);

  ipcMain.handle("pick-folder", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Select a project folder", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  buildMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
