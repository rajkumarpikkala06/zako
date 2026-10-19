const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const app = express();
const db = new Database(path.join(__dirname, 'zako-store.db'));
db.pragma('journal_mode = WAL');
app.use(express.json({limit:'100kb'}));
app.use(express.static(path.join(__dirname,'public')));

db.exec(`CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 price_paise INTEGER NOT NULL DEFAULT 0,
 stock_base INTEGER NOT NULL DEFAULT 0,
 unit TEXT NOT NULL DEFAULT 'pcs',
 low_stock_base INTEGER NOT NULL DEFAULT 0
);`);
const columns = new Set(db.prepare('PRAGMA table_info(products)').all().map(c=>c.name));
const extras = {
 category: "TEXT NOT NULL DEFAULT 'General'",
 price_unit: "TEXT",
 created_at: "TEXT"
};
for (const [col, definition] of Object.entries(extras)) {
 if(!columns.has(col)) db.exec(`ALTER TABLE products ADD COLUMN ${col} ${definition}`);
}
const units = {kg:['weight',1000],gm:['weight',1],ltrs:['volume',1000],ml:['volume',1],pcs:['count',1]};
const aliases = {g:'gm',grams:'gm',gram:'gm',kgs:'kg',kilogram:'kg',kilograms:'kg',l:'ltrs',ltr:'ltrs',litre:'ltrs',litres:'ltrs',liter:'ltrs',liters:'ltrs',piece:'pcs',pieces:'pcs',pc:'pcs'};
function canonical(unit){const u=String(unit||'').trim().toLowerCase();return aliases[u]||u;}
function quantity(raw, expectedGroup){
 const m=String(raw||'').trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
 if(!m) throw Error('Enter quantity like 5 kg, 500 gm, 2 ltrs or 10 pcs.');
 const u=canonical(m[2]); if(!units[u]) throw Error('Unsupported unit.');
 if(expectedGroup && units[u][0]!==expectedGroup) throw Error('Stock and price units must be compatible.');
 const value=Number(m[1])*units[u][1];
 if(!Number.isSafeInteger(value)||value<0) throw Error('Quantity must be a whole number of grams, ml or pieces.');
 return {value,unit:u,group:units[u][0]};
}
function view(row){
 const u=canonical(row.unit);const multiplier=units[u]?.[1]||1;
 const qty=Number(row.stock_base||0)/multiplier;
 const threshold=Number(row.low_stock_base||0);
 return {id:row.id,name:row.name,category:row.category||'General',price:Number(row.price_paise||0)/100,
 priceUnit:row.price_unit||u,stock:qty+' '+u,stockBase:row.stock_base,unit:u,
 lowStock:threshold/multiplier+' '+u,lowStockBase:threshold,
 status:row.stock_base<=0?'out':row.stock_base<=threshold?'low':'available'};
}
function parseProduct(body){
 const name=String(body.name||'').trim();
 if(!name||name.length>120) throw Error('Product name must be 1–120 characters.');
 const stock=quantity(body.stock);
 const low=quantity(body.lowStock,stock.group);
 const priceUnit=canonical(body.priceUnit);
 if(!units[priceUnit]||units[priceUnit][0]!==stock.group) throw Error('Choose a compatible selling price unit.');
 const price=Number(body.price);
 if(!Number.isFinite(price)||price<0||price>10000000||!Number.isSafeInteger(Math.round(price*100))) throw Error('Enter a valid selling price.');
 const category=String(body.category||'General').trim().slice(0,80)||'General';
 return {name,category,price_paise:Math.round(price*100),stock_base:stock.value,unit:stock.unit,low_stock_base:low.value,price_unit:priceUnit};
}
function sendError(res,e){res.status(400).json({error:e.message});}
app.get('/api/health',(_req,res)=>res.json({success:true,application:'Zako Store',database:'Connected'}));
app.get('/api/products',(_req,res)=>res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(view)));
app.get('/api/dashboard',(_req,res)=>{
 const p=db.prepare('SELECT * FROM products').all().map(view);
 res.json({total:p.length,available:p.filter(x=>x.status==='available').length,low:p.filter(x=>x.status==='low').length,out:p.filter(x=>x.status==='out').length,alerts:p.filter(x=>x.status!=='available')});
});
app.post('/api/products',(req,res)=>{
 try {const p=parseProduct(req.body);const result=db.prepare(`INSERT INTO products(name,category,price_paise,stock_base,unit,low_stock_base,price_unit,created_at) VALUES (@name,@category,@price_paise,@stock_base,@unit,@low_stock_base,@price_unit,datetime('now'))`).run(p);
 res.status(201).json(view(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid)));}catch(e){sendError(res,e);}
});
app.put('/api/products/:id',(req,res)=>{
 try {const p=parseProduct(req.body);const result=db.prepare(`UPDATE products SET name=@name,category=@category,price_paise=@price_paise,stock_base=@stock_base,unit=@unit,low_stock_base=@low_stock_base,price_unit=@price_unit WHERE id=@id`).run({...p,id:req.params.id});
 if(!result.changes)return res.status(404).json({error:'Product not found'});
 res.json(view(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id)));}catch(e){sendError(res,e);}
});
app.post('/api/products/:id/restock',(req,res)=>{
 try {const row=db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);if(!row)return res.status(404).json({error:'Product not found'});
 const q=quantity(req.body.quantity,units[canonical(row.unit)]?.[0]);if(q.value<=0)throw Error('Restock quantity must be greater than zero.');
 if(!Number.isSafeInteger(row.stock_base+q.value))throw Error('Stock quantity too large.');
 db.prepare('UPDATE products SET stock_base=stock_base+? WHERE id=?').run(q.value,row.id);
 res.json(view(db.prepare('SELECT * FROM products WHERE id=?').get(row.id)));}catch(e){sendError(res,e);}
});

// Phase 2: bills, customer dues and auditable stock movements.
db.exec(`
 CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
 CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  subtotal_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL,
  tax_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  received_paise INTEGER NOT NULL,
  due_paise INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
 CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity_base INTEGER NOT NULL,
  quantity_text TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  line_total_paise INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS due_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  amount_paise INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
 CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity_delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  sale_id INTEGER REFERENCES sales(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
 CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_phone ON customers(phone) WHERE phone <> '';
`);
const priceToPaise = (raw,label) => {
 const n=Number(raw);
 if(raw === '' || raw === null || raw === undefined || !Number.isFinite(n) || n < 0 || n > 100000000 || Math.abs(Math.round(n*100)-n*100)>0.00001) throw Error('Enter a valid '+label+' (up to 2 decimals).');
 return Math.round(n*100);
};
const integerId = raw => {const n=Number(raw);if(!Number.isSafeInteger(n)||n<=0)throw Error('Invalid ID');return n;};
const roundDiv=(a,b)=>Math.round(a/b);
const saleView = id => {
 const sale=db.prepare(`SELECT s.*,c.name customer_name,c.phone customer_phone FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`).get(id);
 if(!sale)return null;
 return {...sale,items:db.prepare('SELECT product_id,product_name,quantity_text,quantity_base,unit_price_paise,line_total_paise FROM sale_items WHERE sale_id=?').all(id),adjustments:db.prepare('SELECT amount_paise,note,created_at FROM due_adjustments WHERE sale_id=? ORDER BY id').all(id)};
};
app.get('/api/customers',(_req,res)=>{
 res.json(db.prepare(`SELECT c.id,c.name,c.phone,COUNT(DISTINCT s.id) bill_count,COALESCE(SUM(s.total_paise),0) spent_paise,COALESCE(SUM(s.due_paise),0) due_paise FROM customers c LEFT JOIN sales s ON s.customer_id=c.id GROUP BY c.id ORDER BY c.name`).all());
});
app.get('/api/customers/:id/history',(req,res)=>{
 try{const id=integerId(req.params.id);const customer=db.prepare('SELECT id,name,phone,created_at FROM customers WHERE id=?').get(id);if(!customer)return res.status(404).json({error:'Customer not found.'});
 const sales=db.prepare('SELECT id,created_at,total_paise,received_paise,due_paise FROM sales WHERE customer_id=? ORDER BY id DESC').all(id);
 const frequent_products=db.prepare(`SELECT si.product_id,si.product_name,COUNT(DISTINCT si.sale_id) purchase_count FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.customer_id=? GROUP BY si.product_id,si.product_name ORDER BY purchase_count DESC,si.product_name LIMIT 10`).all(id);
 res.json({customer,sales,frequent_products,total_spent_paise:sales.reduce((n,s)=>n+s.total_paise,0),total_due_paise:sales.reduce((n,s)=>n+s.due_paise,0)});
 }catch(e){sendError(res,e);}
});
app.post('/api/customers',(req,res)=>{
 try{const name=String(req.body.name||'').trim();const phone=String(req.body.phone||'').trim();if(!name||name.length>120)throw Error('Customer name required (up to 120 characters).');if(phone.length>20)throw Error('Phone is too long.');
 const r=db.prepare('INSERT INTO customers(name,phone) VALUES (?,?)').run(name,phone);res.status(201).json(db.prepare('SELECT * FROM customers WHERE id=?').get(r.lastInsertRowid));
 }catch(e){res.status(e.code==='SQLITE_CONSTRAINT_UNIQUE'?409:400).json({error:e.code==='SQLITE_CONSTRAINT_UNIQUE'?'Phone number already exists.':e.message});}
});
const createSale=db.transaction(body=>{
 const lines=body.items;
 if(!Array.isArray(lines)||!lines.length||lines.length>100)throw Error('Add between 1 and 100 bill items.');
 const customerId=body.customerId?integerId(body.customerId):null;
 if(customerId&&!db.prepare('SELECT id FROM customers WHERE id=?').get(customerId))throw Error('Customer not found.');
 const items=[];let subtotal=0;
 const needed=new Map();
 for(const line of lines){
  const id=integerId(line.productId);const product=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!product)throw Error('Product not found.');
  const stockUnit=canonical(product.unit);const q=quantity(line.quantity,units[stockUnit][0]);if(q.value<=0)throw Error('Quantity must be greater than zero.');
  const pu=canonical(product.price_unit||stockUnit);const divisor=units[pu][1];
  const lineTotal=roundDiv(product.price_paise*q.value,divisor);
  if(!Number.isSafeInteger(lineTotal))throw Error('Bill amount too large.');
  subtotal+=lineTotal;if(!Number.isSafeInteger(subtotal))throw Error('Bill amount too large.');
  needed.set(id,(needed.get(id)||0)+q.value);
  items.push({product,quantity:q.value,quantityText:String(line.quantity).trim(),lineTotal});
 }
 for(const [id,required] of needed){const product=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!Number.isSafeInteger(required)||required>product.stock_base)throw Error('Insufficient stock for '+product.name+'.');}
 const discount=priceToPaise(body.discount??0,'discount');if(discount>subtotal)throw Error('Discount cannot exceed subtotal.');
 const taxRate=Number(body.taxPercent??0);if(!Number.isFinite(taxRate)||taxRate<0||taxRate>100)throw Error('Tax must be between 0 and 100%.');
 const tax=roundDiv((subtotal-discount)*Math.round(taxRate*100),10000);
 const total=subtotal-discount+tax;
 if(!Number.isSafeInteger(total))throw Error('Total too large.');
 const received=priceToPaise(body.received??total/100,'amount received');
 if(received>total)throw Error('Amount received cannot exceed bill total.');
 if(!customerId&&received<total)throw Error('Select a customer to record an outstanding amount.');
 const r=db.prepare('INSERT INTO sales(customer_id,subtotal_paise,discount_paise,tax_paise,total_paise,received_paise,due_paise) VALUES (?,?,?,?,?,?,?)').run(customerId,subtotal,discount,tax,total,received,total-received);
 const saleId=Number(r.lastInsertRowid);
 const addItem=db.prepare('INSERT INTO sale_items(sale_id,product_id,product_name,quantity_base,quantity_text,unit_price_paise,line_total_paise) VALUES (?,?,?,?,?,?,?)');
 const move=db.prepare('INSERT INTO stock_movements(product_id,quantity_delta,reason,sale_id) VALUES (?, ?, ?, ?)');
 const deduct=db.prepare('UPDATE products SET stock_base=stock_base-? WHERE id=? AND stock_base>=?');
 for(const item of items){addItem.run(saleId,item.product.id,item.product.name,item.quantity,item.quantityText,item.product.price_paise,item.lineTotal);move.run(item.product.id,-item.quantity,'sale',saleId);const u=deduct.run(item.quantity,item.product.id,item.quantity);if(u.changes!==1)throw Error('Insufficient stock for '+item.product.name+'.');}
 return saleId;
});
app.post('/api/sales',(req,res)=>{try{const id=createSale(req.body||{});res.status(201).json(saleView(id));}catch(e){sendError(res,e);}});
app.get('/api/sales',(_req,res)=>res.json(db.prepare(`SELECT s.id,s.created_at,s.total_paise,s.received_paise,s.due_paise,COALESCE(c.name,'Walk-in') customer_name,(SELECT COUNT(*) FROM sale_items i WHERE i.sale_id=s.id) item_count FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC LIMIT 300`).all()));
app.get('/api/sales/:id',(req,res)=>{try{const sale=saleView(integerId(req.params.id));if(!sale)return res.status(404).json({error:'Bill not found'});res.json(sale);}catch(e){sendError(res,e);}});
const recordSettlement=db.transaction((id,amount,note)=>{
 const sale=db.prepare('SELECT * FROM sales WHERE id=?').get(id);if(!sale)throw Error('Bill not found.');if(amount<=0||amount>sale.due_paise)throw Error('Amount must be greater than zero and not exceed outstanding balance.');
 db.prepare('UPDATE sales SET received_paise=received_paise+?,due_paise=due_paise-? WHERE id=?').run(amount,amount,id);
 db.prepare('INSERT INTO due_adjustments(sale_id,amount_paise,note) VALUES (?,?,?)').run(id,amount,note);
});
app.post('/api/sales/:id/settle',(req,res)=>{try{const id=integerId(req.params.id);const amount=priceToPaise(req.body.amount,'settlement amount');const note=String(req.body.note||'').trim().slice(0,200);recordSettlement(id,amount,note);res.json(saleView(id));}catch(e){sendError(res,e);}});
app.get('/api/sales-summary',(_req,res)=>res.json(db.prepare('SELECT COUNT(*) bill_count,COALESCE(SUM(total_paise),0) sales_paise,COALESCE(SUM(due_paise),0) due_paise FROM sales').get()));


// Phase 3 — supplier directory, purchase receipts and sales reports.
db.exec(`
 CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
 CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity_base INTEGER NOT NULL,
  quantity_text TEXT NOT NULL,
  cost_paise INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
`);
app.get('/api/suppliers',(_req,res)=>res.json(db.prepare(`SELECT s.*,COUNT(p.id) purchase_count,COALESCE(SUM(p.cost_paise),0) purchased_paise FROM suppliers s LEFT JOIN purchases p ON p.supplier_id=s.id GROUP BY s.id ORDER BY s.name`).all()));
app.post('/api/suppliers',(req,res)=>{try{
 const name=String(req.body.name||'').trim(),phone=String(req.body.phone||'').trim(),notes=String(req.body.notes||'').trim();
 if(!name||name.length>120)throw Error('Supplier name is required (up to 120 characters).');
 if(phone.length>25||notes.length>300)throw Error('Phone or notes are too long.');
 const r=db.prepare('INSERT INTO suppliers(name,phone,notes) VALUES (?,?,?)').run(name,phone,notes);
 res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(r.lastInsertRowid));
 }catch(e){sendError(res,e);}});
app.get('/api/purchases',(_req,res)=>res.json(db.prepare(`SELECT p.id,p.created_at,p.quantity_text,p.cost_paise,p.note,s.name supplier_name,pr.name product_name FROM purchases p JOIN suppliers s ON s.id=p.supplier_id JOIN products pr ON pr.id=p.product_id ORDER BY p.id DESC LIMIT 300`).all()));
const savePurchase=db.transaction(body=>{
 const supplierId=integerId(body.supplierId),productId=integerId(body.productId);
 if(!db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId))throw Error('Supplier not found.');
 const product=db.prepare('SELECT * FROM products WHERE id=?').get(productId);if(!product)throw Error('Product not found.');
 const q=quantity(body.quantity,units[canonical(product.unit)]?.[0]);if(q.value<=0)throw Error('Purchase quantity must be positive.');
 if(!Number.isSafeInteger(product.stock_base+q.value))throw Error('Stock limit exceeded.');
 const cost=priceToPaise(body.cost,'total purchase cost');
 const note=String(body.note||'').trim().slice(0,300);
 const r=db.prepare('INSERT INTO purchases(supplier_id,product_id,quantity_base,quantity_text,cost_paise,note) VALUES (?,?,?,?,?,?)').run(supplierId,productId,q.value,String(body.quantity).trim(),cost,note);
 db.prepare('UPDATE products SET stock_base=stock_base+? WHERE id=?').run(q.value,productId);
 db.prepare('INSERT INTO stock_movements(product_id,quantity_delta,reason,sale_id) VALUES (?,?,?,NULL)').run(productId,q.value,'supplier purchase #'+r.lastInsertRowid);
 return Number(r.lastInsertRowid);
});
app.post('/api/purchases',(req,res)=>{try{const id=savePurchase(req.body||{});res.status(201).json({id,success:true});}catch(e){sendError(res,e);}});
app.get('/api/reports',(req,res)=>{try{
 const from=String(req.query.from||''),to=String(req.query.to||'');
 const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d));
 if((from&&!valid(from))||(to&&!valid(to)))throw Error('Dates must use YYYY-MM-DD.');
 if(from&&to&&from>to)throw Error('Start date must not exceed end date.');
 const clause=`WHERE (? = '' OR date(s.created_at) >= ?) AND (? = '' OR date(s.created_at) <= ?)`;
 const params=[from,from,to,to];
 const totals=db.prepare(`SELECT COUNT(*) bill_count,COALESCE(SUM(s.total_paise),0) sales_paise,COALESCE(SUM(s.received_paise),0) received_paise,COALESCE(SUM(s.due_paise),0) due_paise FROM sales s ${clause}`).get(...params);
 const daily=db.prepare(`SELECT date(s.created_at) day,COUNT(*) bills,SUM(s.total_paise) sales_paise FROM sales s ${clause} GROUP BY date(s.created_at) ORDER BY day DESC LIMIT 90`).all(...params);
 const top=db.prepare(`SELECT si.product_name,SUM(si.line_total_paise) sales_paise,COUNT(DISTINCT si.sale_id) bills FROM sale_items si JOIN sales s ON s.id=si.sale_id ${clause} GROUP BY si.product_id,si.product_name ORDER BY sales_paise DESC LIMIT 10`).all(...params);
 const inventory=db.prepare('SELECT COUNT(*) products,COALESCE(SUM(CASE WHEN stock_base<=low_stock_base THEN 1 ELSE 0 END),0) low_or_out FROM products').get();
 res.json({totals,daily,top,inventory});
 }catch(e){sendError(res,e);}});

// Phase 5: expiry metadata, inventory insights and downloadable SQLite backup.
const expiryColumns = new Set(db.prepare('PRAGMA table_info(products)').all().map(c=>c.name));
if (!expiryColumns.has('expiry_date')) db.exec('ALTER TABLE products ADD COLUMN expiry_date TEXT');
app.get('/api/phase5/insights',(_req,res)=>{
 try {
  const products=db.prepare(`SELECT id,name,category,stock_base,low_stock_base,unit,expiry_date FROM products ORDER BY name`).all();
  const today=new Date().toISOString().slice(0,10);
  const next=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
  const expiring=products.filter(p=>p.expiry_date && p.expiry_date<=next).map(p=>({...p,expiry_status:p.expiry_date<today?'Expired':p.expiry_date===today?'Expires today':'Within 30 days'}));
  const restock=products.filter(p=>p.stock_base<=p.low_stock_base).map(p=>({...p,suggested_base:Math.max(0,p.low_stock_base*2-p.stock_base)}));
  const customers=db.prepare(`SELECT c.id,c.name,c.phone,COUNT(s.id) bills,COALESCE(SUM(s.total_paise),0) spent_paise,COALESCE(SUM(s.due_paise),0) due_paise FROM customers c LEFT JOIN sales s ON s.customer_id=c.id GROUP BY c.id ORDER BY spent_paise DESC LIMIT 20`).all();
  // Estimated gross profit: allocate each purchase's total cost over its received quantity,
  // using the most recent recorded cost per base unit. Historical sale costs were not snapshotted.
  const sales=db.prepare(`SELECT si.product_id,si.product_name,SUM(si.quantity_base) sold_base,SUM(si.line_total_paise) revenue_paise FROM sale_items si GROUP BY si.product_id,si.product_name`).all();
  const costs=db.prepare(`SELECT product_id,quantity_base,cost_paise FROM purchases WHERE quantity_base>0 ORDER BY id DESC`).all();
  const costByProduct=new Map(); for(const row of costs)if(!costByProduct.has(row.product_id))costByProduct.set(row.product_id,row.cost_paise/row.quantity_base);
  let estimatedProfitPaise=0,coveredRevenuePaise=0,unpricedCount=0;
  for(const row of sales){const unitCost=costByProduct.get(row.product_id);if(unitCost===undefined){unpricedCount++;continue;}estimatedProfitPaise+=row.revenue_paise-Math.round(row.sold_base*unitCost);coveredRevenuePaise+=row.revenue_paise;}
  res.json({expiring,restock,customers,profit:{estimated_profit_paise:Math.round(estimatedProfitPaise),covered_revenue_paise:coveredRevenuePaise,unpriced_product_count:unpricedCount}});
 }catch(e){sendError(res,e);}
});
app.put('/api/phase5/products/:id/expiry',(req,res)=>{
 try{const id=integerId(req.params.id);const date=String(req.body.expiryDate||'').trim();
  if(date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date))throw Error('Use a valid expiry date.');
  const result=db.prepare('UPDATE products SET expiry_date=? WHERE id=?').run(date||null,id);
  if(!result.changes)return res.status(404).json({error:'Product not found'});
  res.json({success:true,id,expiryDate:date||null});
 }catch(e){sendError(res,e);}
});
// Backups are read-only downloads; restore is deliberately manual to prevent accidental overwrites.
app.get('/api/phase5/backup',async(req,res)=>{
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip))return res.status(403).json({error:'Backups can only be downloaded on this computer.'});
 const os=require('os'),fs=require('fs');
 const filename='zako-store-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db';
 const tmp=path.join(os.tmpdir(),'zako-'+process.pid+'-'+Date.now()+'.db');
 try{await db.backup(tmp);res.download(tmp,filename,err=>{fs.unlink(tmp,()=>{});if(err)console.error('Backup download:',err.message);});}
 catch(e){fs.unlink(tmp,()=>{});console.error(e);if(!res.headersSent)res.status(500).json({error:'Unable to create backup'});}
});


// Phase 6A: daily closing, controlled stock adjustments and local activity log.
db.exec(`
 CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  product_id INTEGER,
  quantity_delta INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
 CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(id DESC);
`);
const phase6Adjust = db.transaction((body)=>{
 const productId=integerId(body.productId);
 const product=db.prepare('SELECT * FROM products WHERE id=?').get(productId);
 if(!product)throw Error('Product not found.');
 const reason=String(body.reason||'').trim();
 if(!['damaged','expired','missing','correction'].includes(reason))throw Error('Choose a valid adjustment reason.');
 const mode=String(body.mode||'remove');
 if(!['add','remove'].includes(mode))throw Error('Choose add or remove.');
 if(mode==='add' && reason!=='correction')throw Error('Only stock corrections can increase stock.');
 const parsed=quantity(body.quantity,units[canonical(product.unit)][0]);
 if(parsed.value<=0)throw Error('Quantity must be greater than zero.');
 const delta=mode==='add'?parsed.value:-parsed.value;
 if(product.stock_base+delta<0)throw Error('Cannot remove more than current stock.');
 if(!Number.isSafeInteger(product.stock_base+delta))throw Error('Stock quantity too large.');
 const note=String(body.note||'').trim().slice(0,200);
 db.prepare('UPDATE products SET stock_base=stock_base+? WHERE id=?').run(delta,productId);
 db.prepare('INSERT INTO stock_movements(product_id,quantity_delta,reason) VALUES (?,?,?)').run(productId,delta,'adjustment:'+reason);
 db.prepare('INSERT INTO activity_log(action,description,product_id,quantity_delta) VALUES (?,?,?,?)').run('stock_adjustment',reason+' — '+product.name+' — '+(delta>0?'+':'-')+String(body.quantity).trim()+(note?' — '+note:''),productId,delta);
 return {product:view(db.prepare('SELECT * FROM products WHERE id=?').get(productId))};
});
app.post('/api/phase6/adjustments',(req,res)=>{
 try{res.status(201).json(phase6Adjust(req.body||{}));}catch(e){sendError(res,e);}
});
app.get('/api/phase6/activity',(_req,res)=>{
 try{res.json(db.prepare('SELECT id,action,description,created_at FROM activity_log ORDER BY id DESC LIMIT 100').all());}catch(e){sendError(res,e);}
});
app.get('/api/phase6/daily-close',(req,res)=>{
 try{
  const date=String(req.query.date||new Date().toISOString().slice(0,10));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Error('Choose a valid date.');
  // SQLite created_at values use UTC; date filtering follows those recorded UTC dates.
  const sales=db.prepare(`SELECT COUNT(*) bills,COALESCE(SUM(subtotal_paise),0) subtotal_paise,COALESCE(SUM(discount_paise),0) discount_paise,COALESCE(SUM(tax_paise),0) tax_paise,COALESCE(SUM(total_paise),0) sales_paise,COALESCE(SUM(received_paise),0) received_paise,COALESCE(SUM(due_paise),0) due_paise FROM sales WHERE date(created_at)=?`).get(date);
  const adjustments=db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(CASE WHEN quantity_delta<0 THEN 1 ELSE 0 END),0) removals FROM activity_log WHERE action='stock_adjustment' AND date(created_at)=?`).get(date);
  const settlements=db.prepare(`SELECT COALESCE(SUM(amount_paise),0) settled_paise FROM due_adjustments WHERE date(created_at)=?`).get(date);
  res.json({date,sales,adjustments,settlements,timezone:'UTC',note:'Recorded bill receipts are cumulative; settlements may have occurred on later days. No payment method is tracked.'});
 }catch(e){sendError(res,e);}
});


// Phase 7 — read-only business analytics. Dates follow UTC values stored in SQLite.
app.get('/api/phase7/analytics',(req,res)=>{
 try{
  const days=Number(req.query.days||7);
  if(![7,30,90].includes(days))throw Error('Choose 7, 30 or 90 days.');
  const start=db.prepare("SELECT date('now', ? || ' days') AS start").get('-'+(days-1)).start;
  const daily=db.prepare(`WITH RECURSIVE dates(day) AS (SELECT ? UNION ALL SELECT date(day,'+1 day') FROM dates WHERE day<date('now'))
   SELECT dates.day,COUNT(s.id) bills,COALESCE(SUM(s.total_paise),0) revenue_paise,COALESCE(SUM(s.discount_paise),0) discount_paise
   FROM dates LEFT JOIN sales s ON date(s.created_at)=dates.day GROUP BY dates.day ORDER BY dates.day`).all(start);
  const top=db.prepare(`SELECT si.product_id,si.product_name,COUNT(DISTINCT si.sale_id) bill_count,SUM(si.quantity_base) quantity_base,
    SUM(si.line_total_paise) revenue_paise FROM sale_items si JOIN sales s ON s.id=si.sale_id
    WHERE date(s.created_at)>=? GROUP BY si.product_id,si.product_name ORDER BY revenue_paise DESC LIMIT 10`).all(start);
  const customers=db.prepare(`SELECT c.id,c.name,c.phone,COUNT(s.id) bills,COALESCE(SUM(s.total_paise),0) spent_paise,
    COALESCE(SUM(s.due_paise),0) due_paise FROM customers c LEFT JOIN sales s ON s.customer_id=c.id
    GROUP BY c.id HAVING due_paise>0 ORDER BY due_paise DESC LIMIT 30`).all();
  const inventory=db.prepare(`SELECT id,name,category,stock_base,low_stock_base,unit FROM products WHERE stock_base<=low_stock_base ORDER BY stock_base ASC LIMIT 50`).all();
  const total=daily.reduce((v,r)=>v+r.revenue_paise,0);
  res.json({days,start,timezone:'UTC',daily,top,customers,inventory,summary:{bills:daily.reduce((v,r)=>v+r.bills,0),revenue_paise:total,average_bill_paise:daily.reduce((v,r)=>v+r.bills,0)?Math.round(total/daily.reduce((v,r)=>v+r.bills,0)):0,discount_paise:daily.reduce((v,r)=>v+r.discount_paise,0)}});
 }catch(e){sendError(res,e);}
});

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Server error'});});
const PORT=3000;
app.listen(PORT,()=>console.log(`Zako Store running at http://localhost:${PORT}`));
