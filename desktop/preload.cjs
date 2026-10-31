'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set([
  'state:get', 'ui:bounds', 'ui:modal', 'tab:new', 'tab:activate', 'tab:close',
  'tab:navigate', 'tab:back', 'tab:forward', 'tab:reload', 'tab:stop',
  'sidebar:toggle', 'agent:configure', 'agent:submit', 'agent:takeover',
  'agent:resume', 'agent:cancel', 'agent:decision', 'agent:recover',
  'window:minimize', 'window:toggleMaximize', 'window:close'
]);
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  invoke(action, payload = {}) {
    if (!actions.has(action)) return Promise.reject(new Error('不支持的操作'));
    return ipcRenderer.invoke('mini-dsh:action', action, payload);
  },
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('A listener is required');
    const receive = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('mini-dsh:state', receive);
    return () => ipcRenderer.removeListener('mini-dsh:state', receive);
  },
  onFocusAddress(listener) {
    if (typeof listener !== 'function') throw new TypeError('A listener is required');
    const receive = () => listener();
    ipcRenderer.on('mini-dsh:focus-address', receive);
    return () => ipcRenderer.removeListener('mini-dsh:focus-address', receive);
  }
}));
