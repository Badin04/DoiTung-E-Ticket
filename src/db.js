'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const digest = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${digest}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  try {
    const [salt, hex] = stored.split(':');
    const expected = Buffer.from(hex, 'hex');
    const actual = scryptSync(String(password), salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}

function initDb(filePath, credentials) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','staff'))
    );
    CREATE TABLE IF NOT EXISTS ticket_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL CHECK (price >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL DEFAULT '',
      visit_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','paid')),
      total INTEGER NOT NULL CHECK (total >= 0),
      created_at TEXT NOT NULL,
      paid_at TEXT
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id),
      ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
      unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
      qr_token TEXT NOT NULL UNIQUE,
      visit_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','used')),
      checked_in_at TEXT,
      checked_in_by TEXT REFERENCES users(username)
    );
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      checked_in_by TEXT NOT NULL REFERENCES users(username),
      checked_in_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_date ON tickets(visit_date);
  `);
  const demoTypes = [
    ['villa', 'พระตำหนักดอยตุง', 'ชมประวัติและสถาปัตยกรรม', 100, 1],
    ['garden', 'สวนแม่ฟ้าหลวง', 'เดินชมสวนดอกไม้และธรรมชาติ', 100, 2],
    ['hall', 'หอแห่งแรงบันดาลใจ', 'นิทรรศการเรื่องราวการพัฒนา', 100, 3],
    ['arboretum', 'สวนรุกขชาติแม่ฟ้าหลวง', 'สัมผัสพันธุ์ไม้บนพื้นที่สูง', 100, 4],
    ['combo', 'บัตรรวม 4 สถานที่', 'ตัวเลือกตัวอย่างสำหรับเที่ยวหลายจุด', 250, 5]
  ];
  const insertType = db.prepare('INSERT OR IGNORE INTO ticket_types(id,name,description,price,sort_order) VALUES (?,?,?,?,?)');
  for (const row of demoTypes) insertType.run(...row);
  const insertUser = db.prepare('INSERT OR IGNORE INTO users(username,password_hash,role) VALUES (?,?,?)');
  insertUser.run('admin', hashPassword(credentials.admin), 'admin');
  insertUser.run('staff', hashPassword(credentials.staff), 'staff');
  return db;
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = callback(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = { initDb, verifyPassword, transaction };
