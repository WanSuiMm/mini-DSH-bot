import { app } from 'electron';
import { createDesktopApp } from './main.mjs';

app.setName('mini-DSH Browser');
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let desktop;
  app.on('second-instance', () => { desktop?.window?.show(); desktop?.window?.focus(); });
  app.whenReady().then(async () => {
    desktop = await createDesktopApp();
  }).catch(() => {
    // Keep secrets, remote page text and private paths out of terminal output.
    console.error('mini-DSH Browser could not start. Check the private application-data directory and installed dependencies.');
    app.exit(1);
  });
}
