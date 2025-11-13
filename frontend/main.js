const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const url = require('url');

const isProd = process.env.NODE_ENV === 'production';
const devServerURL = process.env.ELECTRON_START_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0B0B0F',
    title: 'Magicflip',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (devServerURL && !isProd) {
    win.loadURL(devServerURL);
  } else {
    const indexPath = url.format({
      pathname: path.join(__dirname, 'build', 'index.html'),
      protocol: 'file:',
      slashes: true,
    });
    win.loadURL(indexPath);
  }

  if (!isProd && process.env.ELECTRON_OPEN_DEVTOOLS === 'true') {
    win.webContents.once('did-frame-finish-load', () => {
      win.webContents.openDevTools({ mode: 'detach' });
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});