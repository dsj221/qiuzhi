const assert = require('node:assert/strict');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('playwright');
const profile = require('../extension/fixture-profile.json');

test('the extension sends one greeting through the editor and verifies a fresh receipt', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="fixture-account"><h1>测试账号</h1></div>
      <div id="fixture-target-title">测试岗位</div><div id="fixture-target-company">测试公司</div>
      <div id="fixture-messages"></div>
      <div id="fixture-editor"><textarea id="fixture-input"></textarea>
        <a id="send"><span style="pointer-events:none">发送</span></a>
      </div>
      <div id="cover" style="position:fixed;inset:0;background:white"></div>
    `);
    await page.evaluate(() => {
      window.chrome = {runtime: {id: 'fixture', onMessage: {addListener(fn) {window.listener = fn;}}}};
      window.clicks = 0;
      document.querySelector('#send').onclick = () => {
        const row = document.createElement('div');
        row.className = 'fixture-message from-me';
        row.dataset.messageId = 'receipt-' + ++window.clicks;
        row.textContent = document.querySelector('textarea').value;
        document.querySelector('#fixture-messages').append(row);
      };
    });
    for (const script of ['boss-adapter.js', 'pipeline-adapter.js', 'content.js']) {
      await page.addScriptTag({path: path.resolve(__dirname, '../extension', script)});
    }
    const action = {id: 'test', account_label: '测试账号', title: '测试岗位', company: '测试公司',
      mode: 'greeting', message: '您好，希望了解这个岗位。', expires_at: Date.now()/1000 + 60};
    const call = (type, extra = {}) => page.evaluate(message => new Promise(resolve => {
      window.listener(message, {id: 'fixture'}, resolve);
    }), {type, action, profile, ...extra});

    const prepared = await call('PIPE_PREPARE_GREETING');
    assert.equal(prepared.ok, true);
    const baseline = prepared.data.message_ids;
    assert.equal((await call('PIPE_VERIFY', {baseline})).data.outcome, 'UNKNOWN');
    assert.match((await call('PIPE_SEND_GREETING')).error, /遮挡/);
    assert.equal(await page.evaluate(() => window.clicks), 0);

    // Expire the action while the send control is covered.
    await page.evaluate(cancel => setTimeout(() => window.listener(cancel, {id:'fixture'}, () => {}), 50),
      {type:'PIPE_CANCEL', profile});
    assert.match((await call('PIPE_SEND_GREETING')).error, /停止/);
    assert.equal((await call('PIPE_PREPARE_GREETING')).ok, true);
    await page.evaluate(() => setTimeout(() => document.querySelector('#cover').remove(), 100));
    assert.equal((await call('PIPE_SEND_GREETING')).data.clicked, true);
    const receipt = (await call('PIPE_VERIFY', {baseline})).data;
    assert.equal(receipt.outcome, 'COMMUNICATING');
    assert.equal(receipt.receipt_key, 'receipt-1');
    assert.equal((await call('PIPE_SEND_GREETING')).ok, false);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally {
    await browser.close();
  }
});
