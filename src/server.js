'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');

const PORT = Number(process.env.PORT || 3000);
const ROLE = process.env.ROLE || 'api';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'pulse', user: process.env.DB_USER || 'pulse',
  password: process.env.DB_PASSWORD || 'pulse', max: 10, connectionTimeoutMillis: 5000,
});

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: `pulse_${ROLE}_` });
const httpRequests = new client.Counter({ name: 'pulse_http_requests_total', help: 'Total Pulse API HTTP requests', labelNames: ['method','route','status_code'], registers: [register] });
const httpDuration = new client.Histogram({ name: 'pulse_http_request_duration_seconds', help: 'Pulse API HTTP request duration', labelNames: ['method','route','status_code'], buckets: [0.01,0.025,0.05,0.1,0.25,0.5,1,2.5], registers: [register] });
const checksCounter = new client.Counter({ name: 'pulse_checks_total', help: 'Synthetic checks performed by Pulse', labelNames: ['service_id','service_name','result'], registers: [register] });
const targetUp = new client.Gauge({
  name: 'pulse_target_up', help: 'Latest service check result (1 is up)', labelNames: ['service_id','service_name'], registers: ROLE==='worker'?[register]:[],
  async collect() { this.reset(); const r=await pool.query(`SELECT s.id,s.name,c.ok FROM services s LEFT JOIN LATERAL(SELECT ok FROM checks WHERE service_id=s.id ORDER BY checked_at DESC LIMIT 1)c ON true WHERE s.enabled=true`); for(const row of r.rows)this.set({service_id:String(row.id),service_name:row.name},row.ok===true?1:0); }
});
const targetLatency = new client.Gauge({
  name: 'pulse_target_latency_seconds', help: 'Latest service check latency', labelNames: ['service_id','service_name'], registers: ROLE==='worker'?[register]:[],
  async collect() { this.reset(); const r=await pool.query(`SELECT s.id,s.name,c.latency_ms FROM services s LEFT JOIN LATERAL(SELECT latency_ms FROM checks WHERE service_id=s.id ORDER BY checked_at DESC LIMIT 1)c ON true WHERE s.enabled=true`); for(const row of r.rows)if(row.latency_ms!==null)this.set({service_id:String(row.id),service_name:row.name},row.latency_ms/1000); }
});
const openIncidents = new client.Gauge({
  name: 'pulse_open_incidents_total', help: 'Current open incidents', labelNames: ['severity'], registers: [register],
  async collect() { this.reset(); for(const severity of ['warning','critical'])this.set({severity},0); const r=await pool.query("SELECT severity,COUNT(*)::int count FROM incidents WHERE status='open' GROUP BY severity"); for(const row of r.rows)this.set({severity:row.severity},row.count); }
});

async function initDb(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS services(id BIGSERIAL PRIMARY KEY,name VARCHAR(80) NOT NULL,url VARCHAR(500) NOT NULL UNIQUE,check_interval INTEGER NOT NULL DEFAULT 30 CHECK(check_interval BETWEEN 15 AND 3600),enabled BOOLEAN NOT NULL DEFAULT true,last_checked_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS checks(id BIGSERIAL PRIMARY KEY,service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),ok BOOLEAN NOT NULL,status_code INTEGER,latency_ms INTEGER NOT NULL,error VARCHAR(500));
    CREATE INDEX IF NOT EXISTS checks_service_time_idx ON checks(service_id,checked_at DESC);
    CREATE TABLE IF NOT EXISTS incidents(id BIGSERIAL PRIMARY KEY,service_id BIGINT REFERENCES services(id) ON DELETE SET NULL,title VARCHAR(140) NOT NULL,description VARCHAR(1000) NOT NULL DEFAULT '',severity VARCHAR(16) NOT NULL CHECK(severity IN('warning','critical')),status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK(status IN('open','resolved')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),resolved_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS incident_updates(id BIGSERIAL PRIMARY KEY,incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,message VARCHAR(1000) NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS deployments(id BIGSERIAL PRIMARY KEY,service_id BIGINT REFERENCES services(id) ON DELETE SET NULL,version VARCHAR(80) NOT NULL,environment VARCHAR(40) NOT NULL DEFAULT 'production',status VARCHAR(16) NOT NULL CHECK(status IN('success','failed')),deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS maintenance(id BIGSERIAL PRIMARY KEY,service_id BIGINT REFERENCES services(id) ON DELETE CASCADE,title VARCHAR(140) NOT NULL,starts_at TIMESTAMPTZ NOT NULL,ends_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),CHECK(ends_at>starts_at));
  `);
  await pool.query("INSERT INTO services(name,url,check_interval) VALUES('Example API','https://example.com',30) ON CONFLICT(url) DO NOTHING");
}

function parseUrl(value){try{const url=new URL(String(value||'').trim());return ['http:','https:'].includes(url.protocol)?url.toString():null;}catch{return null;}}
async function performCheck(service){
  const started=process.hrtime.bigint(); let ok=false,statusCode=null,error=null;
  try{const response=await fetch(service.url,{signal:AbortSignal.timeout(8000),redirect:'follow',headers:{'User-Agent':'Pulse/1.0'}});statusCode=response.status;ok=response.ok;await response.body?.cancel();}catch(err){error=String(err.message).slice(0,500);}
  const latencyMs=Math.round(Number(process.hrtime.bigint()-started)/1e6);
  const db=await pool.connect();
  try{await db.query('BEGIN');await db.query('INSERT INTO checks(service_id,ok,status_code,latency_ms,error) VALUES($1,$2,$3,$4,$5)',[service.id,ok,statusCode,latencyMs,error]);await db.query('UPDATE services SET last_checked_at=NOW() WHERE id=$1',[service.id]);await db.query('COMMIT');}catch(err){await db.query('ROLLBACK');throw err;}finally{db.release();}
  checksCounter.inc({service_id:String(service.id),service_name:service.name,result:ok?'success':'failure'}); return {ok,status_code:statusCode,latency_ms:latencyMs,error};
}

async function startWorker(){
  console.log('Pulse checker worker started');
  const tick=async()=>{try{const due=await pool.query(`SELECT * FROM services WHERE enabled=true AND(last_checked_at IS NULL OR last_checked_at<=NOW()-check_interval*INTERVAL '1 second') ORDER BY last_checked_at NULLS FIRST LIMIT 20`);await Promise.allSettled(due.rows.map(performCheck));await pool.query("DELETE FROM checks WHERE checked_at<NOW()-INTERVAL '7 days'");}catch(error){console.error('Worker tick failed:',error);}};
  await tick();setInterval(tick,5000).unref();
  http.createServer(async(req,res)=>{if(req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"status":"ok"}');}if(req.url==='/metrics'){try{res.writeHead(200,{'Content-Type':register.contentType});return res.end(await register.metrics());}catch{res.writeHead(500);return res.end();}}res.writeHead(404);res.end();}).listen(PORT,'0.0.0.0');
}

const asyncRoute=handler=>(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next);
function createApi(){
  const app=express();app.disable('x-powered-by');app.use(express.json({limit:'64kb'}));
  app.use((req,res,next)=>{const started=process.hrtime.bigint();res.on('finish',()=>{const labels={method:req.method,route:req.route?.path||req.path,status_code:String(res.statusCode)};httpRequests.inc(labels);httpDuration.observe(labels,Number(process.hrtime.bigint()-started)/1e9);});next();});
  app.get('/healthz',(_req,res)=>res.json({status:'ok'}));
  app.get('/readyz',asyncRoute(async(_req,res)=>{await pool.query('SELECT 1');res.json({status:'ready'});}));
  app.get('/metrics',asyncRoute(async(_req,res)=>{res.set('Content-Type',register.contentType);res.end(await register.metrics());}));
  app.get('/api/overview',asyncRoute(async(_req,res)=>{
    const services=await pool.query(`SELECT s.*,latest.ok,latest.status_code,latest.latency_ms,latest.error,latest.checked_at,COALESCE(stats.uptime,0)::float uptime_24h,COALESCE(stats.total,0)::int checks_24h FROM services s LEFT JOIN LATERAL(SELECT * FROM checks WHERE service_id=s.id ORDER BY checked_at DESC LIMIT 1)latest ON true LEFT JOIN LATERAL(SELECT ROUND(100.0*COUNT(*)FILTER(WHERE ok)/NULLIF(COUNT(*),0),2)uptime,COUNT(*)total FROM checks WHERE service_id=s.id AND checked_at>NOW()-INTERVAL '24 hours')stats ON true ORDER BY s.created_at`);
    const incidents=await pool.query(`SELECT i.*,s.name service_name FROM incidents i LEFT JOIN services s ON s.id=i.service_id ORDER BY i.created_at DESC LIMIT 50`);
    const deployments=await pool.query(`SELECT d.*,s.name service_name FROM deployments d LEFT JOIN services s ON s.id=d.service_id ORDER BY d.deployed_at DESC LIMIT 30`);
    const maintenance=await pool.query(`SELECT m.*,s.name service_name FROM maintenance m LEFT JOIN services s ON s.id=m.service_id WHERE ends_at>NOW()-INTERVAL '1 day' ORDER BY starts_at`);
    res.json({services:services.rows,incidents:incidents.rows,deployments:deployments.rows,maintenance:maintenance.rows});
  }));
  app.get('/api/services/:id/history',asyncRoute(async(req,res)=>{const r=await pool.query('SELECT checked_at,ok,status_code,latency_ms,error FROM checks WHERE service_id=$1 ORDER BY checked_at DESC LIMIT 100',[req.params.id]);res.json(r.rows);}));
  app.post('/api/services',asyncRoute(async(req,res)=>{const name=String(req.body.name||'').trim(),url=parseUrl(req.body.url),interval=Number(req.body.check_interval||30);if(!name||name.length>80||!url||![15,30,60,300,900].includes(interval))return res.status(400).json({error:'Проверь имя, URL и интервал'});const r=await pool.query('INSERT INTO services(name,url,check_interval)VALUES($1,$2,$3)RETURNING *',[name,url,interval]);res.status(201).json(r.rows[0]);}));
  app.patch('/api/services/:id',asyncRoute(async(req,res)=>{const r=await pool.query('UPDATE services SET enabled=$1 WHERE id=$2 RETURNING *',[Boolean(req.body.enabled),req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Сервис не найден'});res.json(r.rows[0]);}));
  app.post('/api/services/:id/check',asyncRoute(async(req,res)=>{const r=await pool.query('SELECT * FROM services WHERE id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Сервис не найден'});res.json(await performCheck(r.rows[0]));}));
  app.delete('/api/services/:id',asyncRoute(async(req,res)=>{const r=await pool.query('DELETE FROM services WHERE id=$1',[req.params.id]);res.status(r.rowCount?204:404).end();}));
  app.post('/api/incidents',asyncRoute(async(req,res)=>{const title=String(req.body.title||'').trim(),description=String(req.body.description||'').trim(),severity=req.body.severity;if(!title||!['warning','critical'].includes(severity))return res.status(400).json({error:'Проверь название и severity'});const r=await pool.query('INSERT INTO incidents(service_id,title,description,severity)VALUES($1,$2,$3,$4)RETURNING *',[req.body.service_id||null,title,description,severity]);res.status(201).json(r.rows[0]);}));
  app.post('/api/incidents/:id/updates',asyncRoute(async(req,res)=>{const message=String(req.body.message||'').trim();if(!message)return res.status(400).json({error:'Введите сообщение'});await pool.query('INSERT INTO incident_updates(incident_id,message)VALUES($1,$2)',[req.params.id,message]);res.status(201).json({ok:true});}));
  app.patch('/api/incidents/:id/resolve',asyncRoute(async(req,res)=>{const r=await pool.query("UPDATE incidents SET status='resolved',resolved_at=NOW() WHERE id=$1 RETURNING *",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Инцидент не найден'});res.json(r.rows[0]);}));
  app.post('/api/deployments',asyncRoute(async(req,res)=>{const version=String(req.body.version||'').trim(),environment=String(req.body.environment||'production').trim(),status=req.body.status;if(!version||!['success','failed'].includes(status))return res.status(400).json({error:'Проверь версию и статус'});const r=await pool.query('INSERT INTO deployments(service_id,version,environment,status)VALUES($1,$2,$3,$4)RETURNING *',[req.body.service_id||null,version,environment,status]);res.status(201).json(r.rows[0]);}));
  app.post('/api/maintenance',asyncRoute(async(req,res)=>{const title=String(req.body.title||'').trim();if(!title||!req.body.starts_at||!req.body.ends_at)return res.status(400).json({error:'Заполни все поля'});const r=await pool.query('INSERT INTO maintenance(service_id,title,starts_at,ends_at)VALUES($1,$2,$3,$4)RETURNING *',[req.body.service_id||null,title,req.body.starts_at,req.body.ends_at]);res.status(201).json(r.rows[0]);}));
  app.use(express.static(path.join(__dirname,'..','public')));
  app.use((error,_req,res,_next)=>{console.error(error);res.status(error.code==='23505'?409:500).json({error:error.code==='23505'?'Такой URL уже добавлен':'Внутренняя ошибка сервера'});});return app;
}
async function start(){for(let i=1;i<=30;i+=1){try{await initDb();break;}catch(error){console.error(`Database not ready (${i}/30): ${error.message}`);if(i===30)process.exit(1);await new Promise(r=>setTimeout(r,3000));}}if(ROLE==='worker')await startWorker();else createApi().listen(PORT,'0.0.0.0',()=>console.log(`Pulse API listening on ${PORT}`));}
process.on('SIGTERM',async()=>{await pool.end();process.exit(0);});process.on('SIGINT',async()=>{await pool.end();process.exit(0);});
if(require.main===module)start();module.exports={initDb,performCheck,createApi};
