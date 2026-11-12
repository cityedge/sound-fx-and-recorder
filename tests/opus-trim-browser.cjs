const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const tmp = path.join(__dirname, 'tmp', 'opus-trim');
const extension = path.join(tmp, 'extension');
fs.mkdirSync(extension, { recursive: true });
fs.cpSync(path.join(root, 'sound-fx-and-recorder'), extension, { recursive: true });
// Test-only injection replaces tabCapture with a controlled stereo signal.
// The production offscreen engine, MediaRecorder, OPFS, worker and Downloads run unchanged.
fs.appendFileSync(path.join(extension, 'offscreen.html'), '<script src="qa-engine.js"></script>\n', 'utf8');
fs.writeFileSync(path.join(extension, 'qa.html'), '<!doctype html><title>Sound FX recording QA</title><p>Recording QA</p><input id="fixture" type="file">', 'utf8');
fs.writeFileSync(path.join(extension, 'qa-engine.js'), `
let qaContext, qaGain, qaAnalyser;
const qaWarnings=[]; const qaWarn=console.warn;
console.warn=(...args)=>{qaWarnings.push(args.map(x=>x?.message||String(x)).join(' '));qaWarn(...args);};
const qaTrim = OpusRecording.prototype._trimFile;
OpusRecording.prototype._trimFile = async function(file) {
  const handle=await this.directory.getFileHandle('qa-original.webm',{create:true});
  const writer=await handle.createWritable(); await writer.write(file); await writer.close();
  return qaTrim.call(this,file);
};
navigator.mediaDevices.getUserMedia = async () => {
  qaContext = new AudioContext({ sampleRate: 48000 });
  const dest = qaContext.createMediaStreamDestination();
  qaGain = qaContext.createGain(); qaGain.gain.value = 0;
  const merger = qaContext.createChannelMerger(2);
  for (let i=0;i<2;i++) {
    const osc = qaContext.createOscillator(); osc.frequency.value = i ? 880 : 440;
    osc.connect(merger,0,i); osc.start();
  }
  merger.connect(qaGain); qaGain.connect(dest); await qaContext.resume();
  return dest.stream;
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'qa') return;
  if (message.type === 'signal') {
    const now = qaContext.currentTime;
    qaGain.gain.cancelScheduledValues(now); qaGain.gain.setValueAtTime(0,now);
    for (const [time,gain] of message.steps) qaGain.gain.setValueAtTime(gain,now+time);
    reply({ ok:true });
  } else if (message.type === 'inspect') {
    if (!qaAnalyser && recorderNode) { qaAnalyser=audioContext.createAnalyser(); recorderNode.connect(qaAnalyser); }
    const samples = new Float32Array(2048); if(qaAnalyser) qaAnalyser.getFloatTimeDomainData(samples);
    reply({ ...getPublicState(), pcmChunks:pcmChunks.length, context:audioContext?.state,
      peak:Math.max(...samples.map(Math.abs)), pending:pendingOpusDownloads.size, warnings:qaWarnings });
  } else if (message.type === 'close') {
    qaContext?.close(); qaAnalyser=null; reply({ok:true});
  } else if (message.type === 'force-trim-failure') {
    activeOpusRecording._trimFile = function(){return qaTrim.call(this,new File([new Uint8Array([0])],'invalid-test.webm'));}; reply({ok:true});
  }
});
`, 'utf8');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(150); }
  throw new Error('Polling timed out');
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile-' + Date.now()), {
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true, acceptDownloads: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: tmp });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('chrome-extension://' + id + '/qa.html');
    const send = (target, type, fields = {}) => page.evaluate((message) => chrome.runtime.sendMessage(message), { target, type, ...fields });
    assert.equal((await send('service-worker','ensure-offscreen')).ok, true);
    await poll(async()=> (await page.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length);
    const fx = { mode:'wide', effectAmount:50, bassLevel:0, trebleLevel:0, bypass:true };
    assert.equal((await send('offscreen','start-fx',{data:{streamId:'qa',tabTitle:'QA',fx}})).ok,true);

    const results = [];
    const cases = process.env.ONLY_STRESS ? [] : process.env.QUICK ? [['opus-stereo',true]] : [
      ['opus-stereo',true], ['opus-stereo',false], ['opus-mono',true], ['opus-mono',false],
      ['opus-mono',true,'silence'], ['opus-stereo',true,'short'], ['wav',true]
    ];
    for (const [format, trim, special] of cases) {
      const before = await page.evaluate(async()=> (await chrome.downloads.search({})).map(d=>d.id));
      assert.equal((await send('offscreen','start-recording',{settings:{recordingFormat:format,autoTrim:trim,autoStop10Min:true,useTabTitle:true}})).ok,true);
      const steps = special==='silence' ? [] : special==='short' ? [[0.4,0.1],[0.42,0]]
        : [[1.5,0.15],[2.5,0],[3.5,0.15],[4.5,0]];
      await send('qa','signal',{steps});
      await delay(special ? 1300 : 6200);
      const during = await send('qa','inspect');
      if(format!=='wav') assert.equal(during.pcmChunks,0);
      const stop = await send('offscreen','stop-recording');
      assert.equal(stop.ok,true,JSON.stringify(stop));
      assert.equal(stop.state.active,true);
      if(stop.state.recordingWarning) console.log('ENGINE WARNINGS',await send('qa','inspect'));
      const downloaded = await poll(async()=> {
        const list = await page.evaluate(()=>chrome.downloads.search({}));
        return list.find(d=>!before.includes(d.id)&&d.state==='complete');
      });
      const file = path.join(tmp, path.basename(downloaded.filename));
      const named = path.join(tmp, format+'-'+(trim?'trim':'full')+(special?'-'+special:'')+path.extname(file));
      fs.copyFileSync(file,named);
      assert.equal(stop.state.recordingWarning,'');
      const probe = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',named],{encoding:'utf8'}));
      assert.equal(probe.streams[0].channels,format==='opus-mono'?1:2);
      const pcm = execFileSync('ffmpeg',['-v','error','-i',named,'-f','f32le','-ar','48000','-ac','2','pipe:1'],{maxBuffer:15*1024*1024});
      const seconds = pcm.length / (48000*2*4);
      if(!special) assert.ok(trim ? seconds>3.7 && seconds<4.0 : seconds>6.0 && seconds<6.5, 'duration '+seconds);
      else assert.ok(seconds>1.0 && seconds<1.6, 'all-silent / short event should stay intact: '+seconds);
      if(trim && format!=='wav') {
        const bytes = await page.evaluate(async()=> {
          const root=await navigator.storage.getDirectory();
          const dir=await root.getDirectoryHandle('sfxr-recording-temp');
          const source=await (await dir.getFileHandle('qa-original.webm')).getFile();
          return Array.from(new Uint8Array(await source.arrayBuffer()));
        });
        const original = new Blob([Buffer.from(bytes)]);
        const {inspect,packets}=require('../sound-fx-and-recorder/webm-opus.js');
        const crypto=require('node:crypto');
        const hashes=async blob=>{const out=[];for await(const p of packets(await inspect(blob)))out.push(crypto.createHash('sha256').update(p.data).digest('hex'));return out;};
        const sourceHashes=await hashes(original);
        const trimmedHashes=await hashes(new Blob([fs.readFileSync(named)]));
        assert.ok(sourceHashes.join(',').includes(trimmedHashes.join(',')),'compressed packets remain a contiguous, byte-identical subsequence');
      }
      await page.locator('#fixture').setInputFiles(named);
      const browserDuration=await page.evaluate(async()=>{
        const audio=new AudioContext();
        try{return (await audio.decodeAudioData(await document.querySelector('#fixture').files[0].arrayBuffer())).duration;}
        finally{await audio.close();}
      });
      assert.ok(Math.abs(browserDuration-seconds)<0.025,'Chrome and FFmpeg decode the same trimmed duration');
      await send('qa','signal',{steps:[[0,0.1]]});
      await delay(150);
      const after = await send('qa','inspect');
      assert.equal(after.active,true); assert.equal(after.context,'running');
      assert.equal(after.bypass,true); assert.equal(after.effectAmount,50);
      assert.ok(after.peak>0.05,'monitor continues');
      await send('qa','signal',{steps:[]});
      if(format!=='wav') await poll(async()=> (await send('qa','inspect')).pending===0);
      results.push({format,trim,special,seconds,browserDuration,channels:probe.streams[0].channels,stats:stop.state});
      console.log('PASS',format,trim,special||'',seconds.toFixed(3));
    }

    // An injected trim failure still downloads the completed original and exposes a warning.
    if(!process.env.QUICK) {
      const before=await page.evaluate(async()=>(await chrome.downloads.search({})).map(d=>d.id));
      await send('offscreen','start-recording',{settings:{recordingFormat:'opus-stereo',autoTrim:true}});
      await send('qa','force-trim-failure'); await send('qa','signal',{steps:[[0,0.1]]});
      await delay(400);
      const result=await send('offscreen','stop-recording');
      assert.equal(result.ok,true);assert.match(result.state.recordingWarning,/saved without trimming/);
      await poll(async()=> (await page.evaluate(()=>chrome.downloads.search({}))).some(d=>!before.includes(d.id)&&d.state==='complete'));
      await send('qa','signal',{steps:[]});
      console.log('PASS trim failure preserves original / warning / final short chunk');
    }

    if(process.env.STRESS_FILE) {
      await page.locator('#fixture').setInputFiles(process.env.STRESS_FILE);
      const began=Date.now();
      const heap=[];
      let heapSession;
      let heapRequest=0;
      cdp.on('Target.receivedMessageFromTarget',event=>{
        const reply=JSON.parse(event.message);
        if(reply.result?.usedSize) heap.push(reply.result);
      });
      const monitor=setInterval(async()=>{
        try {
          if(!heapSession) {
            const targets=await cdp.send('Target.getTargets');
            const target=targets.targetInfos.find(t=>t.type==='worker'&&t.url.endsWith('/opus-trim-worker.js'));
            if(!target)return;
            heapSession=(await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false})).sessionId;
          }
          await cdp.send('Target.sendMessageToTarget',{sessionId:heapSession,message:JSON.stringify({id:++heapRequest,method:'Runtime.getHeapUsage'})});
        }catch{}
      },500);
      let result;
      try { result=await page.evaluate(async()=>{
        const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('sfxr-recording-temp',{create:true});
        const input=await directory.getFileHandle('qa-long-input.webm',{create:true});
        const writable=await input.createWritable();
        await writable.write(document.querySelector('#fixture').files[0]); await writable.close();
        const file=await input.getFile();
        return new Promise((resolve,reject)=>{
          const worker=new Worker(chrome.runtime.getURL('opus-trim-worker.js'));
          worker.onerror=e=>{worker.terminate();reject(new Error(e.message));};
          worker.onmessage=async({data})=>{
            if(data.type==='error'){worker.terminate();reject(new Error(data.error));}
            if(data.type==='complete'){
              worker.terminate();
              const url=URL.createObjectURL(data.file||file);
              const download=await chrome.runtime.sendMessage({target:'service-worker',type:'download-recording',url,filename:'stress-trim.webm'});
              resolve({stats:data.stats,downloadId:download.downloadId});
            }
          };
          worker.postMessage({file,directory,outputName:'qa-stress-trim.webm',settings:{thresholdDb:-55,analysisBlockMs:20,minimumActiveMs:60,leadingPaddingMs:250,trailingPaddingMs:500}});
        });
      }); } finally {clearInterval(monitor);}
      const downloaded=await poll(async()=> {const d=(await page.evaluate(id=>chrome.downloads.search({id}),result.downloadId))[0];return d?.state==='complete'?d:null;});
      assert.ok(result.stats.leadingTrimSeconds>1);assert.ok(result.stats.trailingTrimSeconds>1);
      execFileSync('ffmpeg',['-v','error','-i',downloaded.filename,'-f','null','-'],{timeout:120000});
      const memory={samples:heap.length,maxUsedBytes:Math.max(0,...heap.map(h=>h.usedSize)),maxBackingBytes:Math.max(0,...heap.map(h=>h.backingStorageSize||0))};
      console.log('PASS long OPFS trim',JSON.stringify({seconds:(Date.now()-began)/1000,...result.stats,memory}));
      results.push({stress:result.stats,processingSeconds:(Date.now()-began)/1000,memory});
    }

    // Real extension settings and popup, with real storage and offscreen state.
    const options = await context.newPage();
    options.on('pageerror',(error)=>errors.push(error.message));
    await options.goto('chrome-extension://'+id+'/options.html');
    assert.match(await options.title(),/Settings/);
    await poll(()=>options.locator('#formatDescription').textContent());
    for(const format of ['opus-stereo','opus-mono','wav']) {
      await options.locator('#recordingFormat').selectOption(format);
      assert.equal(await options.locator('#autoTrim').isEnabled(),true);
      await poll(async()=> (await options.locator('#autoStop10Min').isEnabled()) === (format==='wav'));
      await options.locator('#autoTrim').uncheck();
      await poll(()=>options.evaluate(async()=> (await chrome.storage.local.get('autoTrim')).autoTrim===false));
      await options.reload();
      await poll(()=>options.locator('#formatDescription').textContent());
      assert.equal(await options.locator('#autoTrim').isChecked(),false);
      await options.locator('#autoTrim').check();
      await poll(()=>options.evaluate(async()=> (await chrome.storage.local.get('autoTrim')).autoTrim===true));
    }
    await options.locator('#recordingFormat').selectOption('opus-stereo');
    await options.screenshot({path:path.join(tmp,'settings-opus.png'),fullPage:true});
    await options.locator('.card').nth(2).screenshot({path:path.join(tmp,'recording-settings-opus.png')});
    const popup = await context.newPage();
    popup.on('pageerror',(error)=>errors.push(error.message));
    await popup.goto('chrome-extension://'+id+'/popup.html');
    await popup.locator('#displayMode').getByText('BYPASS',{exact:true}).waitFor();
    await popup.locator('[data-mode="hall"]').click();
    await popup.locator('#effectSlider').focus();
    await popup.locator('#effectSlider').press('End');
    for(let i=0;i<3;i++)await popup.locator('#effectSlider').press('ArrowLeft');
    for(let i=0;i<2;i++)await popup.locator('#bassSlider').press('ArrowRight');
    await popup.locator('#trebleSlider').press('ArrowRight');
    await poll(()=>popup.evaluate(async()=> (await chrome.storage.local.get('effectLevels')).effectLevels?.hall===97));
    await popup.locator('[data-mode="wide"]').click();
    await popup.locator('[data-mode="hall"]').click();
    await poll(async()=>{const s=await send('qa','inspect');return s.effectAmount===97&&s.bassLevel===2&&s.trebleLevel===1;});
    await popup.locator('#recordButton').click();
    await send('qa','signal',{steps:[[0,0.1]]});
    await options.locator('#recordingFormat').selectOption('opus-mono');
    await options.locator('#autoTrim').uncheck();
    await popup.locator('#bypassButton').click();
    await popup.locator('#bypassButton').click();
    await delay(400);
    await popup.locator('#recordButton').click();
    await poll(async()=> (await send('qa','inspect')).recordingStatus==='idle');
    const retained=await send('qa','inspect');
    assert.equal(retained.recordingFormat,'opus-stereo');
    assert.equal(retained.recordingWarning,'');
    assert.equal(retained.mode,'hall');assert.equal(retained.effectAmount,97);
    assert.equal(retained.bassLevel,2);assert.equal(retained.trebleLevel,1);assert.equal(retained.bypass,false);
    assert.equal(retained.active,true);assert.ok(retained.peak>0.05);
    console.log('PASS live BYPASS / FX and EQ memory / recording setting snapshot / FX continuity');
    await popup.screenshot({path:path.join(tmp,'popup-after-recording.png')});
    assert.deepEqual(errors,[]);
    await send('offscreen','stop-fx'); await send('qa','close');
    fs.writeFileSync(path.join(tmp,'results.json'),JSON.stringify({browser:context.browser().version(),results,errors},null,2),'utf8');
    console.log('PASS settings shared switch / WAV-only stop / popup / console');
  } finally { await context.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
