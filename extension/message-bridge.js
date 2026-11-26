'use strict';

const readablePageMessages = new Set([
  'PIPE_ACCOUNT', 'PIPE_LIST', 'PIPE_CURRENT', 'PIPE_TARGET', 'PIPE_VERIFY', 'PIPE_SYNC_VERIFY',
  'INSPECT', 'JOB_IMPORT_CONTEXT', 'READ_CHAT', 'READ_JOB', 'READ_JOB_LINK', 'READ_DETAIL_JOB',
  'FOLLOW_NAV_READY', 'FOLLOW_OPEN_CHAT', 'FOLLOW_HINT', 'FOLLOW_READ'
]);

async function extensionMessage(send, canRetry, destination, validateRetry) {
  for (let attempt = 0; ; attempt++) {
    if (attempt && validateRetry) await validateRetry();
    try {
      return await send();
    } catch (error) {
      if (!/Receiving end does not exist/i.test(error.message)) throw error;
      if (!canRetry || attempt === 5) {
        const message = destination === '扩展后台'
          ? '未连接到扩展后台，请重新打开求职侧栏。'
          : destination + '的扩展脚本尚未连接，请刷新该页。';
        const unavailable = new Error(message);
        unavailable.name = canRetry ? 'ReadReceiverUnavailable' : 'ActionReceiverUnavailable';
        throw unavailable;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

function backgroundMessage(type, data = {}, actionId) {
  const read = ['STATUS','JOBS','SEARCH','APPLICATIONS','APP_RECEIPTS','FOLLOW_TARGETS'].includes(type);
  return extensionMessage(() => chrome.runtime.sendMessage({type, data, actionId}), read, '扩展后台');
}

async function tabMessage(tab, message, validateRetry) {
  return extensionMessage(() => chrome.tabs.sendMessage(tab.id, message, {frameId:0}),
    readablePageMessages.has(message.type), 'BOSS 页面', async () => {
      const current = await chrome.tabs.get(tab.id);
      if (!current.active || current.url !== tab.url) throw Error('当前标签页已变化，任务已停止');
      if (validateRetry) await validateRetry();
    });
}
