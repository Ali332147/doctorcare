require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const useRemote = Boolean(process.env.TURSO_DATABASE_URL);
const localDbFile = path.join(__dirname, 'local.db');

// Fallback local database using Node's built-in SQLite (no native libSQL module needed).
function makeLocalDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  const sqlite = new DatabaseSync(file);
  return {
    async execute(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      const args = typeof q === 'string' ? [] : (q.args || []);
      const stmt = sqlite.prepare(sql);
      if (/^\s*(select|pragma|with)\b/i.test(sql)) return { rows: stmt.all(...args), rowsAffected: 0 };
      const r = stmt.run(...args);
      return { rows: [], rowsAffected: Number(r.changes) };
    }
  };
}
function makeDb() {
  if (useRemote) { // pure-JS web client, no native module
    return require('@libsql/client/web').createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  try {
    return require('@libsql/client').createClient({ url: pathToFileURL(localDbFile).href });
  } catch (e) {
    console.warn('Native libSQL could not load (' + e.code + '). Using built-in node:sqlite instead.');
    return makeLocalDb(localDbFile);
  }
}
const db = makeDb();
const app = express();
app.set('trust proxy', 1); // needed behind Render so rate limiting sees real client IPs
const PORT = Number(process.env.PORT || 10000);
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('Set JWT_SECRET to a random secret of at least 32 characters in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'local-development-only-secret-change-before-deploy';
const FILE_DIR = path.join(__dirname, 'uploads'); // private folder, never served statically
const OPEN_HOUR = Number(process.env.OPEN_HOUR || 8), CLOSE_HOUR = Number(process.env.CLOSE_HOUR || 20), SLOT_MIN = Number(process.env.SLOT_MINUTES || 20); // clinic hours 8 AM - 8 PM
const MAX_FILE = 10 * 1024 * 1024, MAX_FILES_PER_PATIENT = 300;
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await db.execute(statement);
  // Backward-compatible migration for databases created by earlier starter versions.
  const appointmentColumns = await db.execute('PRAGMA table_info(appointments)');
  const knownColumns = new Set(appointmentColumns.rows.map(column => column.name));
  for (const [column, type] of [['patient_full_name', 'TEXT'], ['patient_mobile', 'TEXT'], ['patient_email', 'TEXT'], ['patient_age', 'INTEGER']]) {
    if (!knownColumns.has(column)) await db.execute(`ALTER TABLE appointments ADD COLUMN ${column} ${type}`);
  }
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const exists = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [adminEmail] });
  if (!exists.rows.length) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeThisPassword123!', 12);
    await db.execute({ sql: 'INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)', args: [id(), process.env.ADMIN_NAME || 'Super Admin', adminEmail, hash, 'superadmin'] });
    console.log(`Initial admin created: ${adminEmail}. Change the password before production use.`);
  }
  const doctorEmail = 'doctor@example.com';
  if (!process.env.DOCTOR_PASSWORD) console.log('WARNING: DOCTOR_PASSWORD not found. Check that the file is named .env (not .env.txt) and is in the project folder.');
  const doctor = await db.execute({ sql: 'SELECT id FROM users WHERE email=?', args: [doctorEmail] });
  if (!doctor.rows.length) {
    const hash = await bcrypt.hash(process.env.DOCTOR_PASSWORD || crypto.randomBytes(24).toString('hex'), 12);
    await db.execute({ sql: 'INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)', args: [id(), process.env.DOCTOR_NAME || 'Dr. Demo', doctorEmail, hash, 'doctor'] });
  } else if (process.env.DOCTOR_PASSWORD) {
    const hash = await bcrypt.hash(process.env.DOCTOR_PASSWORD, 12);
    await db.execute({ sql: 'UPDATE users SET password_hash=? WHERE email=?', args: [hash, doctorEmail] });
    console.log('Doctor password set from DOCTOR_PASSWORD in .env for ' + doctorEmail);
  }
  // --- multi-doctor migration ---
  const userCols = new Set((await db.execute('PRAGMA table_info(users)')).rows.map(c => c.name));
  if (!userCols.has('profile_json')) await db.execute('ALTER TABLE users ADD COLUMN profile_json TEXT');
  if (!userCols.has('specialty')) await db.execute('ALTER TABLE users ADD COLUMN specialty TEXT');
  if (!knownColumns.has('doctor_id')) await db.execute('ALTER TABLE appointments ADD COLUMN doctor_id TEXT');
  const fileCols = new Set((await db.execute('PRAGMA table_info(medical_files)')).rows.map(c => c.name));
  for (const [c, ty] of [['size_bytes', 'INTEGER'], ['category', 'TEXT'], ['note', 'TEXT'], ['doctor_id', 'TEXT']]) if (!fileCols.has(c)) await db.execute(`ALTER TABLE medical_files ADD COLUMN ${c} ${ty}`);
  fs.mkdirSync(FILE_DIR, { recursive: true });
  const dr = (await db.execute({ sql: 'SELECT id FROM users WHERE email=?', args: [doctorEmail] })).rows[0];
  await db.execute({ sql: 'UPDATE users SET specialty=COALESCE(specialty,?) WHERE id=?', args: [process.env.DOCTOR_SPECIALTY || 'General Physician', dr.id] });
  await db.execute({ sql: 'UPDATE appointments SET doctor_id=? WHERE doctor_id IS NULL', args: [dr.id] });
  await db.execute('DROP INDEX IF EXISTS one_active_slot');
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot_doctor ON appointments(doctor_id,appointment_date,start_time) WHERE status IN ('pending','confirmed','in_consultation')");
}
function auth(req,res,next) {
  const token = req.cookies.session || (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({error:'Please sign in.'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); } catch { return res.status(401).json({error:'Session expired. Please sign in again.'}); }
}
const allow = (...roles) => (req,res,next) => req.user && roles.includes(req.user.role) ? next() : res.status(403).json({error:'Not permitted.'});
async function audit(actor, action, type, target, details={}) {
  await db.execute({sql:'INSERT INTO audit_logs (id,actor_id,action,target_type,target_id,details_json) VALUES (?,?,?,?,?,?)',args:[id(),actor||null,action,type||null,target||null,JSON.stringify(details)]});
}

app.get('/api/health', (_,res) => res.json({ok:true,app:'Single Doctor Telemedicine',time:now()}));
app.get('/api/config', (_,res) => res.json({firstVisitFee:500,followupFee:300,currency:process.env.CURRENCY||'BDT',doctorName:process.env.DOCTOR_NAME||'Dr. Demo',doctorSpecialty:process.env.DOCTOR_SPECIALTY||'',openHour:OPEN_HOUR,closeHour:CLOSE_HOUR,slotMinutes:SLOT_MIN,languages:['bn','en']}));
app.post('/api/auth/register', async (req,res,next) => {
  try {
    const {name,email,phone,password,language='bn'} = req.body || {};
    if (!name || !password || String(password).length < 10 || (!email && !phone)) return res.status(400).json({error:'Name, email or phone, and a password of at least 10 characters are required.'});
    const hash = await bcrypt.hash(password,12), userId=id();
    await db.execute({sql:'INSERT INTO users (id,name,email,phone,password_hash,role,preferred_language) VALUES (?,?,?,?,?,?,?)',args:[userId,String(name).trim(),email?String(email).toLowerCase():null,phone||null,hash,'patient',language==='en'?'en':'bn']});
    res.status(201).json({ok:true,message:'Account created. Please sign in.'});
  } catch(e) { if(String(e.message).includes('UNIQUE')) return res.status(409).json({error:'Email or phone is already registered.'}); next(e); }
});
app.post('/api/auth/login', async (req,res,next) => {
  try {
    const identity=String((req.body||{}).identity||'').trim().toLowerCase(), password=String((req.body||{}).password||'');
    const result=await db.execute({sql:'SELECT id,name,email,phone,password_hash,role,preferred_language,active FROM users WHERE lower(email)=? OR phone=?',args:[identity,identity]});
    const u=result.rows[0];
    if(!u || Number(u.active)===0 || !(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:'Incorrect sign-in details.'});
    const token=jwt.sign({sub:u.id,name:u.name,role:u.role,language:u.preferred_language},JWT_SECRET,{expiresIn:'8h'});
    res.cookie('session',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000});
    res.json({ok:true,user:{id:u.id,name:u.name,role:u.role,language:u.preferred_language}});
  } catch(e){next(e)}
});
app.post('/api/auth/logout',(req,res)=>res.clearCookie('session',{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'}).json({ok:true}));
app.get('/api/me',auth,async(req,res,next)=>{try{const r=await db.execute({sql:'SELECT id,name,email,phone,role,preferred_language,specialty FROM users WHERE id=?',args:[req.user.sub]});res.json({user:r.rows[0]||null})}catch(e){next(e)}});

app.get('/api/appointments',auth,async(req,res,next)=>{try{
 // serial = this appointment's position in that day's queue (cancelled and direct-prescription visits are not counted)
 const serial="CASE WHEN a.status<>'cancelled' AND COALESCE(a.reason,'') NOT LIKE 'Direct prescription%' THEN (SELECT COUNT(*) FROM appointments b WHERE b.doctor_id IS a.doctor_id AND b.appointment_date=a.appointment_date AND b.status<>'cancelled' AND COALESCE(b.reason,'') NOT LIKE 'Direct prescription%' AND b.start_time<=a.start_time) END AS serial";
 let sql='SELECT a.id,a.doctor_id,a.patient_id,a.visit_type,a.fee,a.appointment_date,a.start_time,a.status,a.reason,a.patient_full_name,a.patient_email,a.patient_age,a.video_room,a.payment_status,a.payment_method,a.created_at, COALESCE(a.patient_full_name,u.name) AS patient_name, COALESCE(a.patient_mobile,u.phone) AS patient_mobile, '+serial+', d.name AS doctor_name, d.specialty AS doctor_specialty FROM appointments a JOIN users u ON u.id=a.patient_id LEFT JOIN users d ON d.id=a.doctor_id'; const where=[],args=[];
 if(req.user.role==='patient'){where.push('a.patient_id=?');args.push(req.user.sub)}
 if(req.user.role==='doctor'){where.push('a.doctor_id=?');args.push(req.user.sub)}
 const d=String(req.query.date||'');if(/^\d{4}-\d{2}-\d{2}$/.test(d)){where.push('a.appointment_date=?');args.push(d)}
 if(where.length)sql+=' WHERE '+where.join(' AND ');
 sql+=d?' ORDER BY a.start_time ASC LIMIT 250':' ORDER BY a.appointment_date DESC,a.start_time DESC LIMIT 250';
 const r=await db.execute({sql,args});res.json({appointments:r.rows});
}catch(e){next(e)}});
// ---------- Video consultation (WebRTC, signaling only; media goes peer-to-peer) ----------
let ICE=[{urls:'stun:stun.l.google.com:19302'}];
try{if(process.env.ICE_SERVERS)ICE=JSON.parse(process.env.ICE_SERVERS)}catch{console.warn('ICE_SERVERS is not valid JSON; using default STUN.')}
const CALLS=new Map();
const callRoom=aid=>{if(!CALLS.has(aid))CALLS.set(aid,{doctor:{inbox:[],seen:0},patient:{inbox:[],seen:0},t:Date.now()});return CALLS.get(aid)};
setInterval(()=>{for(const [k,v] of CALLS)if(Date.now()-v.t>3*3600*1000)CALLS.delete(k)},600000).unref();
async function callAccess(req){
 const r=await db.execute({sql:'SELECT id,patient_id,doctor_id,status FROM appointments WHERE id=?',args:[req.params.id]}),a=r.rows[0];if(!a)return null;
 const role=req.user.role==='patient'&&a.patient_id===req.user.sub?'patient':(req.user.role==='doctor'&&a.doctor_id===req.user.sub?'doctor':null);
 return role?{a,role,room:callRoom(a.id)}:null}
const peerOf=r=>r==='doctor'?'patient':'doctor';
app.post('/api/calls/:id/join',auth,async(req,res,next)=>{try{
 const c=await callAccess(req);if(!c)return res.status(404).json({error:'Appointment not found.'});
 if(!['confirmed','in_consultation'].includes(c.a.status))return res.status(400).json({error:'Video call opens after the doctor confirms the appointment.'});
 const me=c.room[c.role],other=c.room[peerOf(c.role)];me.inbox=[];me.seen=Date.now();other.inbox.push({type:'peer-joined'});
 if(c.role==='doctor'&&c.a.status==='confirmed')await db.execute({sql:"UPDATE appointments SET status='in_consultation' WHERE id=?",args:[c.a.id]});
 await audit(req.user.sub,'video_call_joined','appointment',c.a.id,{role:c.role});
 res.json({role:c.role,iceServers:ICE,peerPresent:Date.now()-other.seen<6000});
}catch(e){next(e)}});
app.get('/api/calls/:id/poll',auth,async(req,res,next)=>{try{
 const c=await callAccess(req);if(!c)return res.status(404).json({error:'Appointment not found.'});
 const me=c.room[c.role],other=c.room[peerOf(c.role)];me.seen=Date.now();res.set('Cache-Control','no-store');
 res.json({messages:me.inbox.splice(0),peerPresent:Date.now()-other.seen<6000});
}catch(e){next(e)}});
app.post('/api/calls/:id/signal',auth,async(req,res,next)=>{try{
 const c=await callAccess(req);if(!c)return res.status(404).json({error:'Appointment not found.'});
 const {type,data}=req.body||{};if(!['offer','answer','candidate'].includes(type)||JSON.stringify(data||{}).length>60000)return res.status(400).json({error:'Invalid signal.'});
 const other=c.room[peerOf(c.role)];if(other.inbox.length<200)other.inbox.push({type,data});res.json({ok:true});
}catch(e){next(e)}});
app.post('/api/calls/:id/leave',auth,async(req,res,next)=>{try{
 const c=await callAccess(req);if(!c)return res.status(404).json({error:'Appointment not found.'});
 c.room[c.role].seen=0;c.room[peerOf(c.role)].inbox.push({type:'bye'});res.json({ok:true});
}catch(e){next(e)}});
// ---------- Medical documents (patient <-> doctor) ----------
function sniff(b){ // detect real type from file content; client-declared type is ignored
 if(b.length<12)return null;const a=b.subarray(0,12),l=(x,y)=>a.subarray(x,y).toString('latin1');
 if(l(0,4)==='%PDF')return {mime:'application/pdf',ext:'pdf'};
 if(a[0]===0xFF&&a[1]===0xD8&&a[2]===0xFF)return {mime:'image/jpeg',ext:'jpg'};
 if(a.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])))return {mime:'image/png',ext:'png'};
 if(l(0,4)==='RIFF'&&l(8,12)==='WEBP')return {mime:'image/webp',ext:'webp'};
 if(l(4,8)==='ftyp'&&/^(heic|heix|hevc|mif1|msf1)/.test(l(8,12)))return {mime:'image/heic',ext:'heic'};
 return null}
const hasRelation=async(did,pid)=>(await db.execute({sql:'SELECT 1 FROM appointments WHERE doctor_id=? AND patient_id=? LIMIT 1',args:[did,pid]})).rows.length>0;
const hasShared=async(did,pid)=>(await db.execute({sql:'SELECT 1 FROM medical_files WHERE doctor_id=? AND patient_id=? LIMIT 1',args:[did,pid]})).rows.length>0;
async function canSeeFile(user,f){
 if(user.role==='superadmin')return true;if(user.role==='patient')return f.patient_id===user.sub;
 if(user.role==='doctor')return f.doctor_id===user.sub||(!f.doctor_id&&await hasRelation(user.sub,f.patient_id));return false}
const uploadLimiter=rateLimit({windowMs:15*60*1000,limit:300,standardHeaders:true,legacyHeaders:false});
app.post('/api/files',auth,uploadLimiter,express.raw({type:()=>true,limit:'11mb'}),async(req,res,next)=>{try{
 const buf=req.body;if(!Buffer.isBuffer(buf)||!buf.length)return res.status(400).json({error:'No file received.'});
 if(buf.length>MAX_FILE)return res.status(413).json({error:'File is larger than 10 MB.'});
 const kind=sniff(buf);if(!kind)return res.status(415).json({error:'Only PDF, JPG, PNG, WEBP or HEIC files are allowed.'});
 let patientId,doctorId=null;
 if(req.user.role==='patient'){patientId=req.user.sub;const dq=String(req.query.doctorId||'');if(dq){const d=await db.execute({sql:"SELECT id FROM users WHERE id=? AND role='doctor' AND active=1",args:[dq]});if(!d.rows.length)return res.status(400).json({error:'Choose a valid doctor.'});doctorId=dq}}
 else{patientId=String(req.query.patientId||'');const p=await db.execute({sql:"SELECT id FROM users WHERE id=? AND role='patient'",args:[patientId]});if(!p.rows.length)return res.status(404).json({error:'Patient not found.'});
  if(req.user.role==='doctor'){if(!(await hasRelation(req.user.sub,patientId))&&!(await hasShared(req.user.sub,patientId)))return res.status(403).json({error:'You can upload documents only for your own patients.'});doctorId=req.user.sub}
  else if(req.query.doctorId)doctorId=String(req.query.doctorId)}
 const cnt=await db.execute({sql:'SELECT COUNT(*) AS n FROM medical_files WHERE patient_id=?',args:[patientId]});if(Number(cnt.rows[0].n)>=MAX_FILES_PER_PATIENT)return res.status(400).json({error:'Document limit reached for this patient.'});
 let name='file';try{name=decodeURIComponent(String(req.headers['x-file-name']||'file'))}catch{}
 name=name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,150)||'file';if(!name.toLowerCase().endsWith('.'+kind.ext)&&!(kind.ext==='jpg'&&/\.jpe?g$/i.test(name)))name+='.'+kind.ext;
 const category=['lab','imaging','rx','other'].includes(req.query.category)?req.query.category:'other',note=String(req.query.note||'').trim().slice(0,300);
 const fid=id(),key=fid+'.'+kind.ext;await fs.promises.writeFile(path.join(FILE_DIR,key),buf,{flag:'wx'});
 await db.execute({sql:'INSERT INTO medical_files (id,patient_id,original_name,storage_key,mime_type,uploaded_by,size_bytes,category,note,doctor_id) VALUES (?,?,?,?,?,?,?,?,?,?)',args:[fid,patientId,name,key,kind.mime,req.user.sub,buf.length,category,note||null,doctorId]});
 await audit(req.user.sub,'file_uploaded','medical_file',fid,{patientId,size:buf.length,category});res.status(201).json({ok:true,id:fid,name});
}catch(e){next(e)}});
app.get('/api/files',auth,async(req,res,next)=>{try{
 const pid=req.user.role==='patient'?req.user.sub:String(req.query.patientId||'');if(!pid)return res.status(400).json({error:'Choose a patient.'});
 let sql='SELECT f.id,f.original_name,f.mime_type,f.size_bytes,f.category,f.note,f.created_at,f.uploaded_by,f.doctor_id,u.name AS uploader_name,u.role AS uploader_role,d.name AS doctor_name FROM medical_files f JOIN users u ON u.id=f.uploaded_by LEFT JOIN users d ON d.id=f.doctor_id WHERE f.patient_id=?';const args=[pid];
 if(req.user.role==='doctor'){sql+=(await hasRelation(req.user.sub,pid))?' AND (f.doctor_id=? OR f.doctor_id IS NULL)':' AND f.doctor_id=?';args.push(req.user.sub)}
 const r=await db.execute({sql:sql+' ORDER BY f.created_at DESC LIMIT 500',args});res.json({files:r.rows});
}catch(e){next(e)}});
app.get('/api/files/:id',auth,async(req,res,next)=>{try{
 const r=await db.execute({sql:'SELECT * FROM medical_files WHERE id=?',args:[req.params.id]}),f=r.rows[0];
 if(!f||!(await canSeeFile(req.user,f)))return res.status(404).json({error:'File not found.'});
 await audit(req.user.sub,'file_accessed','medical_file',f.id,{download:Boolean(req.query.download)});
 res.setHeader('Content-Type',f.mime_type);res.setHeader('Cache-Control','private, no-store');
 res.setHeader('Content-Disposition',`${req.query.download?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
 res.sendFile(path.basename(f.storage_key),{root:FILE_DIR,dotfiles:'deny'},err=>{if(err&&!res.headersSent)next(err)});
}catch(e){next(e)}});
app.delete('/api/files/:id',auth,async(req,res,next)=>{try{
 const r=await db.execute({sql:'SELECT * FROM medical_files WHERE id=?',args:[req.params.id]}),f=r.rows[0];
 if(!f||!(await canSeeFile(req.user,f)))return res.status(404).json({error:'File not found.'});
 if(f.uploaded_by!==req.user.sub&&req.user.role!=='superadmin')return res.status(403).json({error:'Only the uploader can delete this file.'});
 await db.execute({sql:'DELETE FROM medical_files WHERE id=?',args:[f.id]});await fs.promises.unlink(path.join(FILE_DIR,path.basename(f.storage_key))).catch(()=>{});
 await audit(req.user.sub,'file_deleted','medical_file',f.id);res.json({ok:true});
}catch(e){next(e)}});
app.get('/api/doctors',async(req,res,next)=>{try{const r=await db.execute("SELECT id,name,specialty FROM users WHERE role='doctor' AND active=1 ORDER BY name");res.json({doctors:r.rows})}catch(e){next(e)}});
app.get('/api/doctors/:id',async(req,res,next)=>{try{const r=await db.execute({sql:"SELECT id,name,specialty,profile_json FROM users WHERE id=? AND role='doctor'",args:[req.params.id]});const d=r.rows[0];if(!d)return res.status(404).json({error:'Doctor not found.'});let profile={};try{profile=JSON.parse(d.profile_json||'{}')}catch{}res.json({doctor:{id:d.id,name:d.name,specialty:d.specialty,profile}})}catch(e){next(e)}});
app.put('/api/doctors/:id/profile',auth,allow('doctor','superadmin'),async(req,res,next)=>{try{
 if(req.user.role==='doctor'&&req.params.id!==req.user.sub)return res.status(403).json({error:'Not permitted.'});
 const b=req.body||{},name=String(b.name||'').trim().slice(0,120),specialty=String(b.specialty||'').trim().slice(0,80);
 if(!name||!specialty)return res.status(400).json({error:'Doctor name and specialty are required.'});
 const profile={};for(const k of ['clinicName','degrees','bmdc','address','phone','hours','footer'])profile[k]=String(b[k]||'').trim().slice(0,['address','hours','footer'].includes(k)?300:150);
 const r=await db.execute({sql:"UPDATE users SET name=?,specialty=?,profile_json=? WHERE id=? AND role='doctor'",args:[name,specialty,JSON.stringify(profile),req.params.id]});
 if(!r.rowsAffected)return res.status(404).json({error:'Doctor not found.'});await audit(req.user.sub,'doctor_profile_saved','user',req.params.id);res.json({ok:true});
}catch(e){next(e)}});
app.get('/api/doctors/:id/booked',async(req,res,next)=>{try{const d=String(req.query.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(d))return res.json({booked:[]});const r=await db.execute({sql:"SELECT start_time FROM appointments WHERE doctor_id=? AND appointment_date=? AND status IN ('pending','confirmed','in_consultation')",args:[req.params.id,d]});res.json({booked:r.rows.map(x=>x.start_time)})}catch(e){next(e)}});
app.get('/api/admin/doctors',auth,allow('superadmin'),async(req,res,next)=>{try{const r=await db.execute("SELECT id,name,email,specialty,active FROM users WHERE role='doctor' ORDER BY name");res.json({doctors:r.rows})}catch(e){next(e)}});
app.post('/api/admin/doctors',auth,allow('superadmin'),async(req,res,next)=>{try{
 const {name,email,password,specialty}=req.body||{};const em=String(email||'').trim().toLowerCase();
 if(!String(name||'').trim()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)||String(password||'').length<10||!String(specialty||'').trim())return res.status(400).json({error:'Name, valid email, specialty and a password of at least 10 characters are required.'});
 const did=id();await db.execute({sql:'INSERT INTO users (id,name,email,password_hash,role,specialty) VALUES (?,?,?,?,?,?)',args:[did,String(name).trim().slice(0,120),em,await bcrypt.hash(String(password),12),'doctor',String(specialty).trim().slice(0,80)]});
 await audit(req.user.sub,'doctor_created','user',did);res.status(201).json({ok:true,id:did});
}catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'This email is already registered.'});next(e)}});
app.post('/api/appointments',auth,allow('patient'),async(req,res,next)=>{try{
 const {visitType,appointmentDate,startTime,patientFullName,patientMobile,patientEmail,patientAge,reason='',doctorId}=req.body||{};
 const fullName=String(patientFullName||'').trim(), mobile=String(patientMobile||'').trim(), email=String(patientEmail||'').trim().toLowerCase(), age=Number(patientAge);
 if(email && (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({error:'Enter a valid email address or leave it blank.'});
 if(fullName.length<2||fullName.length>120) return res.status(400).json({error:'Enter the patient full name (2–120 characters).'});
 if(!/^[+0-9()\-\s]{7,25}$/.test(mobile)) return res.status(400).json({error:'Enter a valid mobile number.'});
 if(patientAge===undefined||patientAge===null||String(patientAge).trim()===''||!Number.isInteger(age)||age<0||age>120) return res.status(400).json({error:'Enter a valid age between 0 and 120.'});
 if(String(reason).trim().length<2||String(reason).length>1000) return res.status(400).json({error:'Enter the reason for visit (up to 1000 characters).'});
 if(!['first','followup'].includes(visitType)||!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime||'')) return res.status(400).json({error:'Choose a valid visit type, date and time.'});
 {const [sh,sm]=startTime.split(':').map(Number),mins=sh*60+sm;if(mins<OPEN_HOUR*60||mins+SLOT_MIN>CLOSE_HOUR*60||(mins-OPEN_HOUR*60)%SLOT_MIN)return res.status(400).json({error:`Choose a time within clinic hours (${OPEN_HOUR}:00 - ${CLOSE_HOUR}:00, ${SLOT_MIN}-minute slots).`})}
 if(new Date(appointmentDate+'T00:00:00Z').toISOString().slice(0,10)!==appointmentDate) return res.status(400).json({error:'Choose a valid date.'});
 const localNow=new Date(Date.now()+Number(process.env.TZ_OFFSET_HOURS||6)*3600*1000).toISOString(),localToday=localNow.slice(0,10);
 if(appointmentDate < localToday) return res.status(400).json({error:'Past dates cannot be booked.'});
 if(appointmentDate===localToday&&startTime<=localNow.slice(11,16))return res.status(400).json({error:'That time has already passed. Choose a later time.'});
 const dq=await db.execute({sql:"SELECT id FROM users WHERE id=? AND role='doctor' AND active=1",args:[String(doctorId||'')]});if(!dq.rows.length)return res.status(400).json({error:'Please choose a doctor.'});
 const fee=visitType==='first'?500:300, apptId=id();
 await db.execute({sql:'INSERT INTO appointments (id,patient_id,visit_type,fee,appointment_date,start_time,reason,status,patient_full_name,patient_mobile,patient_email,patient_age,doctor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',args:[apptId,req.user.sub,visitType,fee,appointmentDate,startTime,String(reason).trim().slice(0,1000),'pending',fullName,mobile,email||null,age,doctorId]});
 await audit(req.user.sub,'appointment_created','appointment',apptId,{visitType,fee,appointmentDate,startTime});res.status(201).json({ok:true,id:apptId,fee,status:'pending',message:'Booking request saved. Await confirmation.'});
}catch(e){if(String(e.message).includes('one_active_slot')||String(e.message).includes('UNIQUE'))return res.status(409).json({error:'That time slot is no longer available. Choose another.'});next(e)}});
app.patch('/api/appointments/:id/cancel',auth,async(req,res,next)=>{try{
 const r=await db.execute({sql:'SELECT * FROM appointments WHERE id=?',args:[req.params.id]}),a=r.rows[0];if(!a)return res.status(404).json({error:'Appointment not found.'});
 if(req.user.role==='patient'&&a.patient_id!==req.user.sub)return res.status(403).json({error:'Not permitted.'});if(!['pending','confirmed'].includes(a.status))return res.status(400).json({error:'This appointment can no longer be cancelled.'});
 await db.execute({sql:"UPDATE appointments SET status='cancelled' WHERE id=?",args:[a.id]});await audit(req.user.sub,'appointment_cancelled','appointment',a.id);res.json({ok:true});
}catch(e){next(e)}});
app.patch('/api/appointments/:id/status',auth,allow('doctor','superadmin'),async(req,res,next)=>{try{
 const allowed=['confirmed','in_consultation','completed','no_show','cancelled'];const status=req.body&&req.body.status;if(!allowed.includes(status))return res.status(400).json({error:'Invalid status.'});
 const r=await db.execute({sql:'UPDATE appointments SET status=? WHERE id=? AND (?=0 OR doctor_id=?)',args:[status,req.params.id,req.user.role==='doctor'?1:0,req.user.sub]});if(!r.rowsAffected)return res.status(404).json({error:'Appointment not found.'});await audit(req.user.sub,'appointment_status_changed','appointment',req.params.id,{status});res.json({ok:true,status});
}catch(e){next(e)}});
app.put('/api/appointments/:id/prescription',auth,allow('doctor','superadmin'),async(req,res,next)=>{try{
 const {diagnosis='',medicines=[],advice='',followupDate=null}=req.body||{};if(!Array.isArray(medicines))return res.status(400).json({error:'Medicines must be a list.'});
 const a=await db.execute({sql:'SELECT id,patient_id,doctor_id FROM appointments WHERE id=?',args:[req.params.id]});if(!a.rows.length)return res.status(404).json({error:'Appointment not found.'});if(req.user.role==='doctor'&&a.rows[0].doctor_id!==req.user.sub)return res.status(403).json({error:'Not permitted.'});
 const existing=await db.execute({sql:'SELECT id FROM prescriptions WHERE appointment_id=?',args:[req.params.id]});const pid=existing.rows[0]?.id||id();
 await db.execute({sql:'INSERT INTO prescriptions (id,appointment_id,doctor_id,diagnosis,medicines_json,advice,followup_date) VALUES (?,?,?,?,?,?,?) ON CONFLICT(appointment_id) DO UPDATE SET diagnosis=excluded.diagnosis,medicines_json=excluded.medicines_json,advice=excluded.advice,followup_date=excluded.followup_date',args:[pid,req.params.id,a.rows[0].doctor_id||req.user.sub,String(diagnosis).slice(0,3000),JSON.stringify(medicines.slice(0,40)),String(advice).slice(0,3000),followupDate||null]});
 await audit(req.user.sub,'prescription_saved','prescription',pid);res.json({ok:true,id:pid});
}catch(e){next(e)}});
app.post('/api/admin/patients/:pid/prescriptions',auth,allow('doctor','superadmin'),async(req,res,next)=>{try{
 const {diagnosis='',medicines=[],advice='',followupDate=null}=req.body||{};if(!Array.isArray(medicines))return res.status(400).json({error:'Medicines must be a list.'});
 const pr=await db.execute({sql:"SELECT id,name,email,phone FROM users WHERE id=? AND role='patient'",args:[req.params.pid]});const p=pr.rows[0];if(!p)return res.status(404).json({error:'Patient not found.'});
 const local=new Date(Date.now()+Number(process.env.TZ_OFFSET_HOURS||6)*3600*1000).toISOString(),apptId=id(),presId=id();
 // A direct prescription is stored on an auto-created completed visit (fee 0) so it appears in the patient's history.
 await db.execute({sql:'INSERT INTO appointments (id,patient_id,visit_type,fee,appointment_date,start_time,reason,status,patient_full_name,patient_mobile,patient_email,doctor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',args:[apptId,p.id,'followup',0,local.slice(0,10),local.slice(11,16),'Direct prescription (no appointment)','completed',p.name,p.phone||'',p.email||null,req.user.role==='doctor'?req.user.sub:null]});
 await db.execute({sql:'INSERT INTO prescriptions (id,appointment_id,doctor_id,diagnosis,medicines_json,advice,followup_date) VALUES (?,?,?,?,?,?,?)',args:[presId,apptId,req.user.sub,String(diagnosis).slice(0,3000),JSON.stringify(medicines.slice(0,40)),String(advice).slice(0,3000),followupDate||null]});
 await audit(req.user.sub,'direct_prescription_saved','prescription',presId,{patientId:p.id,appointmentId:apptId});res.status(201).json({ok:true,id:presId,appointmentId:apptId});
}catch(e){next(e)}});
app.get('/api/appointments/:id/prescription',auth,async(req,res,next)=>{try{
 const r=await db.execute({sql:'SELECT p.*,a.patient_id,a.appointment_date,a.start_time,a.visit_type,COALESCE(a.patient_full_name,u.name) AS patient_name,a.patient_age,d.name AS doctor_name,d.specialty AS doctor_specialty FROM prescriptions p JOIN appointments a ON a.id=p.appointment_id JOIN users u ON u.id=a.patient_id JOIN users d ON d.id=p.doctor_id WHERE p.appointment_id=?',args:[req.params.id]});
 const p=r.rows[0];if(!p)return res.status(404).json({error:'Prescription not found.'});
 if(req.user.role==='patient'&&p.patient_id!==req.user.sub)return res.status(403).json({error:'Not permitted.'});
 if(req.user.role==='doctor'&&p.doctor_id!==req.user.sub)return res.status(403).json({error:'Not permitted.'});
 res.json({prescription:{...p,medicines:JSON.parse(p.medicines_json||'[]')}});
}catch(e){next(e)}});
app.get('/api/admin/summary',auth,allow('superadmin','doctor'),async(req,res,next)=>{try{
 const dw=req.user.role==='doctor'?' AND doctor_id=?':'',da=req.user.role==='doctor'?[req.user.sub]:[];
 const [patients,appointments,completed,revenue,pending]=await Promise.all([
 db.execute("SELECT COUNT(*) AS n FROM users WHERE role='patient'"),db.execute({sql:'SELECT COUNT(*) AS n FROM appointments WHERE 1=1'+dw,args:da}),db.execute({sql:"SELECT COUNT(*) AS n FROM appointments WHERE status='completed'"+dw,args:da}),db.execute({sql:"SELECT COALESCE(SUM(fee),0) AS n FROM appointments WHERE status='completed' AND payment_status='paid'"+dw,args:da}),db.execute({sql:"SELECT COUNT(*) AS n FROM appointments WHERE status='pending'"+dw,args:da})]);
 res.json({patients:Number(patients.rows[0].n),appointments:Number(appointments.rows[0].n),completed:Number(completed.rows[0].n),revenue:Number(revenue.rows[0].n),pending:Number(pending.rows[0].n)});
}catch(e){next(e)}});
app.get('/api/admin/patients',auth,allow('superadmin','doctor'),async(req,res,next)=>{try{const r=await db.execute("SELECT id,name,email,phone,created_at FROM users WHERE role='patient' ORDER BY created_at DESC LIMIT 500");res.json({patients:r.rows})}catch(e){next(e)}});
app.get('/api/admin/audit',auth,allow('superadmin'),async(req,res,next)=>{try{const r=await db.execute('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');res.json({logs:r.rows})}catch(e){next(e)}});
app.use('/api', (err,req,res,next)=>{console.error(err);res.status(500).json({error:process.env.NODE_ENV==='production'?'Unexpected server error.':'Request failed. Check server logs.'})});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
init().then(()=>app.listen(PORT,()=>console.log(`Single Doctor App listening on ${PORT}`))).catch(e=>{console.error('Startup failed',e);process.exit(1)});
