const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');

module.exports = function mountStorageRoutes(app, { store, port, isBusy, setMaintenance, onRestored }) {
  const upload = multer({ dest:path.join(store.dataDir,'restore_upload'), limits:{fileSize:100*1024*1024, files:1} });
  app.use('/api/storage', (req,res,next) => {
    const host=req.get('host');
    const allowed=[`localhost:${port}`,`127.0.0.1:${port}`];
    if (!allowed.includes(host) || (req.get('origin') && req.get('origin') !== `http://${host}`)) return res.status(403).json({error:'数据管理仅允许本机页面访问'});
    if (req.method !== 'GET' && req.get('X-Memo-Storage') !== '1') return res.status(403).json({error:'数据管理请求缺少来源标记'});
    next();
  });
  app.get('/api/storage/status', (req,res) => res.json(store.status()));
  app.get('/api/storage/export', (req,res) => {
    const documents=store.transaction(() => store.exportLegacy());
    const zip=new AdmZip();
    for (const [name,data] of Object.entries(documents)) zip.addFile(name,Buffer.from(JSON.stringify(data,null,2),'utf8'));
    zip.addFile('export-info.json',Buffer.from(JSON.stringify({application:'memo-journal',version:1,exportedAt:new Date().toISOString()})));
    res.attachment(`memo-json-${new Date().toISOString().slice(0,10)}.zip`).type('application/zip').send(zip.toBuffer());
  });
  app.get('/api/storage/backups/:name', (req,res,next) => {
    try { res.download(store.backupPath(req.params.name)); } catch (error) { next(error); }
  });
  app.post('/api/storage/backup', async (req,res) => res.json(await store.createBackup()));
  app.post('/api/storage/restore', upload.single('backup'), async (req,res,next) => {
    let maintenance=false;
    try {
      if (isBusy()) return res.status(409).json({error:'AI 或数据管理任务正在进行，请完成后再恢复'});
      if (req.file && req.body.name) return res.status(400).json({error:'请选择一种恢复方式'});
      const source=req.file?.path || (req.body.name && store.backupPath(req.body.name));
      if (!source) return res.status(400).json({error:'请选择数据库备份'});
      setMaintenance(true);maintenance=true;
      const result=await store.restore(source);
      onRestored();
      res.json({ok:true,...result});
    } catch (error) { next(error); }
    finally {
      if (maintenance) setMaintenance(false);
      if (req.file) fs.rmSync(req.file.path,{force:true});
    }
  });
  app.use('/api/storage', (error,req,res,next) => {
    if (res.headersSent) return next(error);
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({error:error.code === 'LIMIT_FILE_SIZE' ? '备份文件不能超过 100 MB' : error.message});
  });
};
